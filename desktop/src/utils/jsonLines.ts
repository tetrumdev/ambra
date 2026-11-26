/** Read a fetch stream framed as newline-delimited JSON, including blank heartbeats. */
export async function readJsonLines<T>(
  body: ReadableStream<Uint8Array>,
  receive: (value: T) => void,
  heard: () => void,
) {
  // The phone's DOM types (Expo's TextDecoderStream) say it takes any BufferSource; bytes are one.
  const reader = body.pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      heard();
      buffered += value;
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (line) receive(JSON.parse(line) as T);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
