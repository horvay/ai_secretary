import { describe, expect, test } from "bun:test";
import { AudioQueue } from "./audio";

describe("AudioQueue metadata callbacks", () => {
  test("passes queued text to chunk start and playback complete", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    const emptied = new Promise<void>((resolve) => {
      const queue = new AudioQueue({
        playAudio: async () => {},
        onChunkStarted: (item) => {
          started.push(item.text ?? "");
        },
        onPlaybackComplete: (item) => {
          completed.push(item.text ?? "");
        },
        onQueueEmpty: () => resolve(),
      });
      queue.enqueue("data:audio/wav;base64,AAAA", "hello world");
    });

    await emptied;
    expect(started).toEqual(["hello world"]);
    expect(completed).toEqual(["hello world"]);
  });

  test("cancel prevents current chunk metadata from completing", async () => {
    const completed: string[] = [];
    let releasePlayback!: () => void;
    let queue!: AudioQueue;
    const playbackStarted = new Promise<void>((resolve) => {
      queue = new AudioQueue({
        playAudio: async () => {
          resolve();
          await new Promise<void>((release) => {
            releasePlayback = release;
          });
        },
        onPlaybackComplete: (item) => completed.push(item.text ?? ""),
      });
    });

    queue.enqueue("data:audio/wav;base64,AAAA", "interrupted chunk");
    await playbackStarted;
    queue.cancel();
    releasePlayback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toEqual([]);
  });
});
