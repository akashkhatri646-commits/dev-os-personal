/** One block of normalised text with an id that source-span citations refer to. */
export interface NormalizedBlock {
  id: string
  text: string
  /** Mean recognition confidence for the block, 0..1 (1.0 for text that was not OCRed). */
  confidence?: number
  /** Normalised bounding box [x0, y0, x1, y1] in 0..1 page coordinates, when known. */
  bbox?: [number, number, number, number]
}

export interface NormalizedPage {
  page: number
  text: string
  blocks: NormalizedBlock[]
}
