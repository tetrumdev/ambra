import { describe, expect, test } from "bun:test";
import { localCoverSources } from "../src/utils/localArtwork";

const toSource = (path: string) => `asset://${path}`;
const placeholder = "white.png";

describe("localCoverSources", () => {
  test("uses the thumbnail for lists and keeps the original for bigscreen", () => {
    expect(
      localCoverSources({ cover: "/covers/big.jpg", thumbnail: "/thumbs/small.jpg" }, toSource, placeholder),
    ).toEqual({ cover: "asset:///thumbs/small.jpg", fullCover: "asset:///covers/big.jpg" });
  });

  test("falls back to the original until a thumbnail exists or when none is needed", () => {
    for (const thumbnail of [undefined, null, ""]) {
      expect(localCoverSources({ cover: "/covers/big.jpg", thumbnail }, toSource, placeholder)).toEqual({
        cover: "asset:///covers/big.jpg",
        fullCover: undefined,
      });
    }
  });

  test("tracks without artwork use the placeholder", () => {
    expect(localCoverSources({ cover: null, thumbnail: "/ignored.jpg" }, toSource, placeholder)).toEqual({
      cover: placeholder,
      fullCover: undefined,
    });
  });

  test("legacy embedded data URIs are used directly", () => {
    const uri = "data:image/jpeg;base64,AAAA";
    expect(localCoverSources({ cover: uri }, toSource, placeholder)).toEqual({
      cover: uri,
      fullCover: undefined,
    });
  });
});
