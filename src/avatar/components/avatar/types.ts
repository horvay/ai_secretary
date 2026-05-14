export type AvatarState = "idle" | "processing" | "talking";
export type AvatarStatus = string;

/**
 * Metadata for an animated sprite
 */
export interface AnimatedSpriteMetadata {
  status: AvatarStatus;
  type: AvatarState;
  folder: string;
  sourceFile: string;
}

/**
 * A video sprite - stores the video element directly for instant playback
 */
export interface VideoSprite {
  /** The video element */
  video: HTMLVideoElement;
  /** Video duration in seconds */
  duration: number;
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Blob URL (for cleanup) */
  blobUrl: string;
  /** Metadata about the source */
  metadata: AnimatedSpriteMetadata;
}

// Alias for backwards compatibility
export type DecodedSprite = VideoSprite;

export interface AvatarInstance {
  setState: (state: AvatarState) => void;
  setStatus: (status: AvatarStatus) => void;
  setOverrideStateKey: (key: string) => Promise<void>;
  getState: () => AvatarState;
  getStatus: () => AvatarStatus;
  destroy: () => void;
  reloadSprites: () => Promise<void>;
  isLoaded: () => boolean;
}

/**
 * RPC interface for sprite loading (WebM video files)
 */
export interface SpriteRPC {
  /**
   * Load a single animated sprite (WebM video)
   */
  loadAnimatedSprite: (params: { status: AvatarStatus; type: AvatarState; folder: string }) => Promise<{
    mime: "video/webm";
    base64: string;
    metadata: AnimatedSpriteMetadata;
  }>;

  /**
   * Load all animated sprites for a type
   */
  loadAnimatedSpritesForType: (params: { status: AvatarStatus; type: AvatarState }) => Promise<{
    sprites: Record<string, {
      mime: "video/webm";
      base64: string;
      metadata: AnimatedSpriteMetadata;
    }>;
  }>;

  /**
   * Load a one-shot override animation (WebM video)
   */
  loadOverrideSpriteSheet: (params: { key: string }) => Promise<{
    mime: "video/webm";
    base64: string;
    metadata: {
      key: string;
      sourceFile: string;
    };
  }>;

  /**
   * Get information about available sprites
   */
  getSpriteInfo: () => Promise<{
    source: string;
    path: string;
    hasSprites: boolean;
    types: string[];
    statuses: AvatarStatus[];
    folders: Record<string, Record<string, string[]>>;
  }>;
}
