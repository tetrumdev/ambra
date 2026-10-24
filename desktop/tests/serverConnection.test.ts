import { describe, expect, test } from "bun:test";
import { forStorage, fromStorage, serverUrl, setServerForTesting, withServerAccess } from "../src/api/serverConnection";

describe("server URLs in saved data", () => {
  const saved = JSON.stringify({
    audio: "http://127.0.0.1:38147/api/providers/qobuz/tracks/1/stream?quality=27",
    cover: "http://127.0.0.1:38147/api/artwork/thumbnail?provider=qobuz&url=https%3A%2F%2Fstatic.qobuz.com%2Fa.jpg",
    external: "https://static.qobuz.com/images/a.jpg",
    other: "http://example.com/not/api",
  });

  test("a joined device reads them on its server, with its token", () => {
    setServerForTesting("http://192.168.1.20:38147", "tok/en");
    const read = JSON.parse(fromStorage(saved));
    expect(read.audio).toBe("http://192.168.1.20:38147/api/providers/qobuz/tracks/1/stream?quality=27&access_token=tok%2Fen");
    expect(read.cover).toBe("http://192.168.1.20:38147/api/artwork/thumbnail?provider=qobuz&url=https%3A%2F%2Fstatic.qobuz.com%2Fa.jpg&access_token=tok%2Fen");
    expect(read.external).toBe("https://static.qobuz.com/images/a.jpg");
    expect(read.other).toBe("http://example.com/not/api");
  });

  test("tokens never reach saved data, wherever they sat in the query", () => {
    setServerForTesting("http://192.168.1.20:38147", "secret");
    const live = fromStorage(saved);
    expect(live).toContain("secret");
    const written = forStorage(live);
    expect(written).not.toContain("secret");
    expect(written).not.toContain("access_token");
    expect(forStorage('"http://h:1/api/a?access_token=x&b=2"')).toBe('"http://h:1/api/a?b=2"');
    expect(forStorage('"http://h:1/api/a?access_token=x"')).toBe('"http://h:1/api/a"');
    expect(forStorage('"http://h:1/api/a?b=2&access_token=x#t"')).toBe('"http://h:1/api/a?b=2#t"');
  });

  test("the server machine itself needs no token, and moves nothing", () => {
    setServerForTesting("http://127.0.0.1:38147", null);
    expect(fromStorage(saved)).toBe(saved);
    expect(serverUrl("/api/artwork/thumbnail?x=1")).toBe("http://127.0.0.1:38147/api/artwork/thumbnail?x=1");
  });

  test("only this server's URLs get the token", () => {
    setServerForTesting("http://192.168.1.20:38147", "t");
    expect(withServerAccess("https://resources.tidal.com/a.jpg")).toBe("https://resources.tidal.com/a.jpg");
    expect(serverUrl("/api/x")).toBe("http://192.168.1.20:38147/api/x?access_token=t");
  });

  test("permanent local music in playlists resolves on the joined device", () => {
    setServerForTesting("http://192.168.1.20:38147", "t");
    const read = JSON.parse(fromStorage('{"audio":"/api/music/local/files/song.flac","cover":"/api/music/local/files/cover.jpg"}'));
    expect(read.audio).toBe("http://192.168.1.20:38147/api/music/local/files/song.flac?access_token=t");
    expect(read.cover).toBe("http://192.168.1.20:38147/api/music/local/files/cover.jpg?access_token=t");
    expect(forStorage(JSON.stringify(read))).not.toContain("access_token");
  });
});
