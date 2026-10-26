// One second of 8 kHz mono PCM silence for the remote Live Activity's background lease.
const fs = require("node:fs");
const path = require("node:path");
const samples = 8000;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(samples, 24);
wav.writeUInt32LE(samples * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
fs.writeFileSync(path.join(__dirname, "../assets/silence.wav"), wav);
