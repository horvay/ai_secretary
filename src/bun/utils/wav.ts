/**
 * WAV File Utilities
 * Functions for parsing, generating, and manipulating WAV audio data
 */

import { logDebug, logWarn } from "./logger";

export interface WAVInfo {
  duration: number;
  sampleRate: number;
}

export interface WAVChunkInfo {
  buffer: ArrayBuffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

/**
 * Parse WAV header to get duration and sample rate
 */
export function parseWAVHeader(buffer: ArrayBuffer): WAVInfo | null {
  try {
    const view = new DataView(buffer);

    // Check RIFF header
    if (view.getUint32(0, true) !== 0x46464952) {
      // "RIFF"
      return null;
    }

    // Check WAVE format
    if (view.getUint32(8, true) !== 0x45564157) {
      // "WAVE"
      return null;
    }

    // Find fmt chunk
    let offset = 12;
    let sampleRate = 22050; // Default
    let channels = 1;
    let bitsPerSample = 16;

    while (offset < buffer.byteLength - 8) {
      const chunkId = view.getUint32(offset, true);
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkId === 0x20746d66) {
        // "fmt "
        sampleRate = view.getUint32(offset + 12, true);
        channels = view.getUint16(offset + 16, true);
        bitsPerSample = view.getUint16(offset + 22, true);
        break;
      }

      offset += 8 + chunkSize;
      if (chunkSize % 2 === 1) offset++; // Align to word boundary
    }

    // Find data chunk
    offset = 12;
    let dataSize = 0;

    while (offset < buffer.byteLength - 8) {
      const chunkId = view.getUint32(offset, true);
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkId === 0x61746164) {
        // "data"
        dataSize = chunkSize;
        break;
      }

      offset += 8 + chunkSize;
      if (chunkSize % 2 === 1) offset++;
    }

    if (dataSize === 0) {
      return null;
    }

    // Calculate duration: dataSize / (sampleRate * channels * (bitsPerSample / 8))
    const bytesPerSample = (bitsPerSample / 8) * channels;
    const duration = dataSize / (sampleRate * bytesPerSample);

    return { duration, sampleRate };
  } catch {
    return null;
  }
}

/**
 * Generate silence WAV data
 */
export function generateSilence(
  durationSeconds: number,
  sampleRate: number = 22050,
  channels: number = 1,
  bitsPerSample: number = 16
): ArrayBuffer {
  const samples = Math.floor(sampleRate * durationSeconds);
  const bytesPerSample = (bitsPerSample / 8) * channels;
  const dataSize = samples * bytesPerSample;
  const fileSize = 44 + dataSize; // 44 bytes for full header + data

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  // RIFF header (12 bytes)
  view.setUint32(0, 0x46464952, true); // "RIFF"
  view.setUint32(4, fileSize - 8, true); // File size - 8
  view.setUint32(8, 0x45564157, true); // "WAVE"

  // fmt chunk (24 bytes: 8 for header + 16 for data)
  view.setUint32(12, 0x20746d66, true); // "fmt "
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // Audio format (PCM)
  view.setUint16(22, channels, true); // Channels
  view.setUint32(24, sampleRate, true); // Sample rate
  view.setUint32(28, sampleRate * bytesPerSample, true); // Byte rate
  view.setUint16(32, bytesPerSample, true); // Block align
  view.setUint16(34, bitsPerSample, true); // Bits per sample

  // data chunk (8 bytes header + dataSize bytes data)
  view.setUint32(36, 0x61746164, true); // "data"
  view.setUint32(40, dataSize, true); // Data size

  // Data starts at byte 44 and is already zeros (silence)

  return buffer;
}

/**
 * Parse a WAV buffer and extract chunk information for concatenation
 */
function parseWAVChunkInfo(buffer: ArrayBuffer): WAVChunkInfo | null {
  const info = parseWAVHeader(buffer);
  if (!info) {
    logWarn("TTS: Invalid WAV header, skipping buffer of size", buffer.byteLength);
    return null;
  }

  const view = new DataView(buffer);

  // Find data chunk
  let offset = 12;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset < buffer.byteLength - 8) {
    const chunkId = view.getUint32(offset, true);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 0x61746164) {
      // "data"
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 === 1) offset++;
  }

  // Validate data chunk bounds - clamp to actual buffer size
  if (dataOffset === 0 || dataSize === 0) {
    logWarn("TTS: No data chunk found in WAV, buffer size:", buffer.byteLength);
    return null;
  }

  // Ensure we don't read past the buffer
  const maxDataSize = buffer.byteLength - dataOffset;
  if (dataSize > maxDataSize) {
    logWarn(`TTS: Clamping dataSize from ${dataSize} to ${maxDataSize}`);
    dataSize = maxDataSize;
  }

  // Get format info from fmt chunk
  let channels = 1;
  let bitsPerSample = 16;
  offset = 12;
  while (offset < buffer.byteLength - 8) {
    const chunkId = view.getUint32(offset, true);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 0x20746d66) {
      // "fmt "
      channels = view.getUint16(offset + 10, true);
      bitsPerSample = view.getUint16(offset + 22, true);
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 === 1) offset++;
  }

  return {
    buffer,
    sampleRate: info.sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    dataSize,
  };
}

/**
 * Concatenate multiple WAV files with optional silence between them
 */
export function concatenateWAVs(wavBuffers: ArrayBuffer[], pauseSeconds: number = 0.3): ArrayBuffer {
  if (wavBuffers.length === 0) {
    throw new Error("No WAV buffers to concatenate");
  }

  if (wavBuffers.length === 1) {
    return wavBuffers[0];
  }

  // Limit the number of buffers to prevent memory issues
  const MAX_BUFFERS = 50;
  const buffersToProcess = wavBuffers.slice(0, MAX_BUFFERS);

  // Parse all WAV headers to get sample rates and data offsets
  const wavInfos: WAVChunkInfo[] = [];

  let commonSampleRate = 22050;
  let commonChannels = 1;
  let commonBitsPerSample = 16;

  for (const buffer of buffersToProcess) {
    const chunkInfo = parseWAVChunkInfo(buffer);
    if (!chunkInfo) {
      continue;
    }

    // Use the first buffer's format as the common format
    if (wavInfos.length === 0) {
      commonSampleRate = chunkInfo.sampleRate;
      commonChannels = chunkInfo.channels;
      commonBitsPerSample = chunkInfo.bitsPerSample;
    }

    wavInfos.push(chunkInfo);
  }

  // Calculate total data size
  const pauseSize =
    pauseSeconds > 0
      ? Math.floor(commonSampleRate * pauseSeconds * (commonBitsPerSample / 8) * commonChannels)
      : 0;
  const totalDataSize =
    wavInfos.reduce((sum, info) => sum + info.dataSize, 0) + pauseSize * (wavInfos.length - 1);

  // Debug logging
  logDebug(
    `TTS concatenation: ${wavInfos.length} chunks, totalDataSize=${totalDataSize}, pauseSize=${pauseSize}`
  );

  // Sanity check: if total data size is unreasonably large (> 50MB), something is wrong
  const MAX_AUDIO_SIZE = 50 * 1024 * 1024; // 50MB
  if (totalDataSize > MAX_AUDIO_SIZE) {
    logWarn(
      `TTS concatenation: total data size ${totalDataSize} exceeds max ${MAX_AUDIO_SIZE}, falling back to first buffer`
    );
    return buffersToProcess[0];
  }

  // If no valid chunks, return first buffer
  if (wavInfos.length === 0) {
    logWarn("TTS concatenation: no valid WAV chunks found");
    return buffersToProcess[0];
  }

  // Total file size: 44 bytes header (RIFF + fmt + data chunk headers) + audio data
  const totalFileSize = 44 + totalDataSize;

  // Create output buffer
  const output = new ArrayBuffer(totalFileSize);
  const outputView = new DataView(output);

  // Write RIFF header
  outputView.setUint32(0, 0x46464952, true); // "RIFF"
  outputView.setUint32(4, totalFileSize - 8, true); // File size minus 8 bytes for RIFF header
  outputView.setUint32(8, 0x45564157, true); // "WAVE"

  // Write fmt chunk
  outputView.setUint32(12, 0x20746d66, true); // "fmt "
  outputView.setUint32(16, 16, true);
  outputView.setUint16(20, 1, true); // PCM
  outputView.setUint16(22, commonChannels, true);
  outputView.setUint32(24, commonSampleRate, true);
  outputView.setUint32(28, commonSampleRate * (commonBitsPerSample / 8) * commonChannels, true);
  outputView.setUint16(32, (commonBitsPerSample / 8) * commonChannels, true);
  outputView.setUint16(34, commonBitsPerSample, true);

  // Write data chunk header
  outputView.setUint32(36, 0x61746164, true); // "data"
  outputView.setUint32(40, totalDataSize, true);

  // Copy audio data with pauses
  let outputOffset = 44;
  const outputArray = new Uint8Array(output);

  for (let i = 0; i < wavInfos.length; i++) {
    const info = wavInfos[i];
    const sourceArray = new Uint8Array(info.buffer);

    // Safety check: ensure we don't read past the source buffer
    const safeEndOffset = Math.min(info.dataOffset + info.dataSize, sourceArray.length);
    const safeDataSize = safeEndOffset - info.dataOffset;

    if (safeDataSize > 0) {
      // Copy audio data
      outputArray.set(sourceArray.subarray(info.dataOffset, safeEndOffset), outputOffset);
      outputOffset += safeDataSize;
    }

    // Add pause (silence) between chunks (except after the last one)
    if (i < wavInfos.length - 1 && pauseSeconds > 0) {
      // Silence is already zeros, so we don't need to write anything
      outputOffset += pauseSize;
    }
  }

  return output;
}

