// Local-only private DERP fixture. No public relay dependency or privileged sockets.
package main

import (
    "encoding/json"
    "fmt"
    "net"
    "net/http"
    "net/http/httptest"
    "os"
    "os/signal"
    "tailscale.com/derp/derpserver"
    "tailscale.com/tailcfg"
    "tailscale.com/types/key"
    "tailscale.com/types/logger"
)

func main() {
    relay := derpserver.New(key.NewNode(), logger.Discard)
    defer relay.Close()
    server := httptest.NewTLSServer(derpserver.Handler(relay))
    defer server.Close()
    port := server.Listener.Addr().(*net.TCPAddr).Port
    region := &tailcfg.DERPRegion{RegionID: 901, RegionCode: "ambra-test", Nodes: []*tailcfg.DERPNode{{Name:"ambra-test", RegionID:901, HostName:"127.0.0.1", IPv4:"127.0.0.1", IPv6:"none", STUNPort:-1, DERPPort:port, InsecureForTests:true}}}
    maps := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(&tailcfg.DERPMap{Regions:map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{901:region}}) }))
    defer maps.Close()
    fmt.Println(maps.URL)
    stopped := make(chan os.Signal, 1)
    signal.Notify(stopped, os.Interrupt)
    <-stopped
}
