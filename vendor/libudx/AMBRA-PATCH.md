# Ambra patch to libudx 1.7.3

Source: the published libudx 1.7.3 crate from Rightbracket/peeroxide (MIT OR Apache-2.0). License texts and upstream tests are retained.

The native stream's `mtu` is a UDP payload size, including the UDX header. Upstream caps it at 1500 bytes without subtracting IPv4 and UDP headers. On a 1500-byte IP interface this produces 1528-byte IP datagrams and fragmentation. Probes can be acknowledged after reassembly while subsequent fragmented audio bursts suffer loss, retransmission, and HTTP/2 keepalive failures.

The patch caps IPv4 UDP payloads at 1472 bytes. The initial 1200-byte payload and the existing probe, congestion-control, encryption, and retransmission logic remain intact. Ambra's HyperDHT transport uses IPv4. This is not a general solution for paths below 1500 bytes or a replacement for unfragmented path-MTU discovery.

The Ambra `direct_udx_stream_preserves_audio_across_packet_loss` regression exercises a delayed, reordering UDP path that admits padded probes but drops full data datagrams over 1472 bytes. It times out with the upstream cap and transfers authenticated audio with this patch.
