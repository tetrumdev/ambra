pub fn builder() -> reqwest::ClientBuilder {
    // CDN responses can contain hundreds of repeated diagnostic headers.
    // Reqwest's default of 100 rejects otherwise valid audio before reading it.
    reqwest::Client::builder().http1_max_headers(1024)
}
