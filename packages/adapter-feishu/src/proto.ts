/**
 * The tiny protobuf codec the Feishu persistent-connection wire needs.
 *
 * The gateway speaks one binary message, `Frame`, whose schema is fixed and
 * small (nine scalar/repeated fields; each `Header` is just a key/value pair).
 * Pulling in a full protobuf runtime for that would be the wrong trade, so this
 * is the varint reader/writer the schema requires and nothing more. Unknown
 * fields are skipped by wire type, so a server adding a field does not break
 * decoding. The shapes mirror larksuite/node-sdk `ws-client/proto-buf/pbbp2`.
 *
 * @module @derekluo/dsh-channels-feishu/proto
 */

/** One `pbbp2.Header`: a string pair. */
export interface FrameHeader {
  key: string
  value: string
}

/** One `pbbp2.Frame`, decoded into plain values the socket layer can use. */
export interface Frame {
  /** Field 1, varint. The SDK keeps this at 0 outside its own bookkeeping. */
  seqId: number
  /** Field 2, varint. */
  logId: number
  /** Field 3, varint. Echoed from the gateway URL's `service_id`. */
  service: number
  /** Field 4, varint. 0 = control, 1 = data (see {@link FrameType}). */
  method: number
  /** Field 5, repeated length-delimited {@link FrameHeader}. */
  headers: FrameHeader[]
  /** Field 6, string. */
  payloadEncoding: string
  /** Field 7, string. */
  payloadType: string
  /** Field 8, bytes. */
  payload: Uint8Array
  /** Field 9, string. */
  logIdNew: string
}

/** Control vs. data frames, the only values the `method` field takes. */
export const FrameType = { control: 0, data: 1 } as const

class Reader {
  readonly #bytes: Uint8Array
  #pos = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  get pos(): number { return this.#pos }
  get len(): number { return this.#bytes.length }
  get done(): boolean { return this.#pos >= this.#bytes.length }

  uint32(): number {
    return this.varint()
  }

  /** Read an unsigned varint as a safe JS number (our ids never exceed 2^53). */
  varint(): number {
    let shift = 0
    let result = 0
    while (this.#pos < this.#bytes.length) {
      const byte = this.#bytes[this.#pos++]!
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result >>> 0
      shift += 7
      if (shift >= 32) {
        // Larger than uint32: keep accumulating but lose nothing the gateway sends.
        let high = 0
        let highShift = shift - 32
        while (this.#pos < this.#bytes.length) {
          const next = this.#bytes[this.#pos++]!
          high |= (next & 0x7f) << highShift
          if ((next & 0x80) === 0) return result + high * 0x100000000
          highShift += 7
        }
        throw new Error('proto: truncated varint')
      }
    }
    throw new Error('proto: truncated varint')
  }

  bytes(): Uint8Array {
    const length = this.varint()
    const end = this.#pos + length
    if (end > this.#bytes.length) throw new Error('proto: length-delimited field overruns buffer')
    const slice = this.#bytes.subarray(this.#pos, end)
    this.#pos = end
    return slice
  }

  string(): string {
    return new TextDecoder().decode(this.bytes())
  }

  /** Advance past a field whose schema we do not know. */
  skip(wireType: number): void {
    switch (wireType) {
      case 0: this.varint(); return
      case 1: this.skipBytes(8); return
      case 2: this.bytes(); return
      case 5: this.skipBytes(4); return
      default: throw new Error(`proto: unsupported wire type ${wireType}`)
    }
  }

  skipBytes(count: number): void {
    if (this.#pos + count > this.#bytes.length) throw new Error('proto: fixed field overruns buffer')
    this.#pos += count
  }
}

class Writer {
  #chunks: number[] = []

  /** Encode a tag from a field number and wire type (2 = length-delimited, 0 = varint). */
  tag(field: number, wireType: number): this {
    this.varint((field << 3) | wireType)
    return this
  }

  varint(value: number): this {
    let current = Math.floor(value)
    while (current >= 0x80) {
      this.#chunks.push((current & 0x7f) | 0x80)
      current = Math.floor(current / 128)
    }
    this.#chunks.push(current & 0x7f)
    return this
  }

  string(value: string): this {
    this.bytes(new TextEncoder().encode(value))
    return this
  }

  bytes(value: Uint8Array): this {
    this.varint(value.length)
    for (const byte of value) this.#chunks.push(byte)
    return this
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.#chunks)
  }
}

/** Decode one gateway frame. Throws on a truncated or structurally invalid buffer. */
export function decodeFrame(buffer: Uint8Array): Frame {
  const reader = new Reader(buffer)
  const frame: Frame = {
    seqId: 0,
    logId: 0,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: '',
    payloadType: '',
    payload: new Uint8Array(0),
    logIdNew: '',
  }
  while (!reader.done) {
    const tag = reader.uint32()
    const field = tag >>> 3
    const wireType = tag & 7
    switch (field) {
      case 1: frame.seqId = reader.varint(); break
      case 2: frame.logId = reader.varint(); break
      case 3: frame.service = reader.varint(); break
      case 4: frame.method = reader.varint(); break
      case 5: frame.headers.push(decodeHeader(reader.bytes())); break
      case 6: frame.payloadEncoding = reader.string(); break
      case 7: frame.payloadType = reader.string(); break
      case 8: frame.payload = reader.bytes(); break
      case 9: frame.logIdNew = reader.string(); break
      default: reader.skip(wireType)
    }
  }
  return frame
}

function decodeHeader(buffer: Uint8Array): FrameHeader {
  const reader = new Reader(buffer)
  const header: FrameHeader = { key: '', value: '' }
  while (!reader.done) {
    const tag = reader.uint32()
    const field = tag >>> 3
    const wireType = tag & 7
    if (field === 1) header.key = reader.string()
    else if (field === 2) header.value = reader.string()
    else reader.skip(wireType)
  }
  return header
}

/** Encode one frame. Acks and pings only ever set a handful of fields. */
export function encodeFrame(frame: Partial<Frame> & Pick<Frame, 'service' | 'method'>): Uint8Array {
  const writer = new Writer()
  writer.tag(1, 0).varint(frame.seqId ?? 0)
  writer.tag(2, 0).varint(frame.logId ?? 0)
  writer.tag(3, 0).varint(frame.service)
  writer.tag(4, 0).varint(frame.method)
  for (const header of frame.headers ?? []) {
    const nested = new Writer()
    nested.tag(1, 2).string(header.key)
    nested.tag(2, 2).string(header.value)
    writer.tag(5, 2).bytes(nested.finish())
  }
  if (frame.payloadEncoding !== undefined && frame.payloadEncoding !== '') writer.tag(6, 2).string(frame.payloadEncoding)
  if (frame.payloadType !== undefined && frame.payloadType !== '') writer.tag(7, 2).string(frame.payloadType)
  if (frame.payload !== undefined && frame.payload.length > 0) writer.tag(8, 2).bytes(frame.payload)
  if (frame.logIdNew !== undefined && frame.logIdNew !== '') writer.tag(9, 2).string(frame.logIdNew)
  return writer.finish()
}
