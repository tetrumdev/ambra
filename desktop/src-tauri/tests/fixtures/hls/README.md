Generated silence, not a recording: 12 seconds of stereo FLAC at 44.1 kHz in fragmented MP4.
The first two segments contain 179712 frames each. The test playlist uses the
12-second audio duration rather than the muxer's padded last-segment duration.
The first segment is deliberately omitted so the seek regression catches requests for it.

Generation command:
```
ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 12 -c:a flac -strict experimental -f dash -seg_duration 4 stream.mpd
```
