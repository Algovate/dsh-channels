/** Stop reading a response as soon as its advertised or actual size exceeds the limit. */
export async function readBoundedResponse(response, maxBytes) {
    if (Number(response.headers.get("content-length")) > maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    if (!response.body)
        return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                return Buffer.concat(chunks, size);
            size += value.byteLength;
            if (size > maxBytes) {
                void reader.cancel().catch(() => {});
                throw new Error(`response exceeds ${maxBytes} bytes`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
}
