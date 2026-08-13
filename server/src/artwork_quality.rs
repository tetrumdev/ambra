use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkCandidate {
    pub provider: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub colors: Vec<String>,
}

impl ArtworkCandidate {
    fn pixel_count(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }
}

pub fn highest_resolution(
    source: ArtworkCandidate,
    alternatives: impl IntoIterator<Item = ArtworkCandidate>,
) -> ArtworkCandidate {
    alternatives.into_iter().fold(source, |best, candidate| {
        if candidate.pixel_count() > best.pixel_count() {
            candidate
        } else {
            best
        }
    })
}

/// UPC-A, EAN-13, and GTIN-14 encode the same release with different numbers
/// of leading zeroes on different services. Nothing except that padding is
/// normalized: a title/artist similarity is never enough to cross providers.
pub fn normalized_upc(value: &str) -> Option<String> {
    let digits = value.trim();
    if !(8..=14).contains(&digits.len()) || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    let normalized = digits.trim_start_matches('0');
    (!normalized.is_empty()).then(|| normalized.to_owned())
}

pub fn same_release_upc(left: &str, right: &str) -> bool {
    normalized_upc(left)
        .zip(normalized_upc(right))
        .is_some_and(|(left, right)| left == right)
}

pub fn qobuz_max_artwork_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("static.qobuz.com") {
        return None;
    }

    let filename_start = url.rfind('/')? + 1;
    let filename = &url[filename_start..];
    let variant_start = filename.rfind('_')?;
    let extension_start = filename[variant_start..].find('.')? + variant_start;
    let extension = &filename[extension_start..];

    Some(format!(
        "{}{}_max{}",
        &url[..filename_start],
        &filename[..variant_start],
        extension
    ))
}

pub fn trusted_artwork_url(provider: &str, url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }

    matches!(
        (provider, parsed.host_str()),
        ("tidal", Some("resources.tidal.com"))
            | ("qobuz", Some("static.qobuz.com"))
            | ("spotify", Some("i.scdn.co"))
    )
}

pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    png_dimensions(bytes).or_else(|| jpeg_dimensions(bytes))
}

pub fn dominant_colors(bytes: &[u8]) -> Option<Vec<String>> {
    const CANDIDATE_COLORS: usize = 8;

    let image = image::load_from_memory(bytes)
        .ok()?
        .thumbnail(64, 64)
        .to_rgb8();
    let pixels = image
        .pixels()
        .map(|pixel| [pixel[0] as f32, pixel[1] as f32, pixel[2] as f32])
        .collect::<Vec<_>>();
    if pixels.is_empty() {
        return None;
    }

    let average = pixels.iter().fold([0.0_f32; 3], |mut sum, pixel| {
        for channel in 0..3 {
            sum[channel] += pixel[channel];
        }
        sum
    });
    let mut centroids = vec![average.map(|channel| channel / pixels.len() as f32)];
    while centroids.len() < CANDIDATE_COLORS {
        let next = pixels.iter().copied().max_by(|left, right| {
            nearest_color_distance(*left, &centroids)
                .total_cmp(&nearest_color_distance(*right, &centroids))
        })?;
        centroids.push(next);
    }

    let mut assignments = vec![0_usize; pixels.len()];
    for _ in 0..8 {
        for (index, pixel) in pixels.iter().enumerate() {
            assignments[index] = centroids
                .iter()
                .enumerate()
                .min_by(|(_, left), (_, right)| {
                    color_distance(*pixel, **left).total_cmp(&color_distance(*pixel, **right))
                })
                .map(|(index, _)| index)
                .unwrap_or(0);
        }

        let mut sums = [[0.0_f32; 3]; CANDIDATE_COLORS];
        let mut counts = [0_u32; CANDIDATE_COLORS];
        for (pixel, cluster) in pixels.iter().zip(&assignments) {
            for channel in 0..3 {
                sums[*cluster][channel] += pixel[channel];
            }
            counts[*cluster] += 1;
        }
        for cluster in 0..CANDIDATE_COLORS {
            if counts[cluster] > 0 {
                for channel in 0..3 {
                    centroids[cluster][channel] = sums[cluster][channel] / counts[cluster] as f32;
                }
            }
        }
    }

    let mut candidates = centroids
        .into_iter()
        .enumerate()
        .filter_map(|(cluster, color)| {
            let count = assignments
                .iter()
                .filter(|assignment| **assignment == cluster)
                .count();
            (count > 0).then_some(ColorCluster { count, color })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.count.cmp(&left.count));

    let mut selected = vec![candidates.remove(0)];
    if !candidates.is_empty() {
        let second = best_cluster_index(&candidates, &selected, |frequency, distance| {
            frequency * (0.6 + 0.4 * distance)
        });
        selected.push(candidates.remove(second));
    }

    if !candidates.is_empty() {
        let minimum_accent_pixels = ((pixels.len() as f32 * 0.005).ceil() as usize).max(2);
        let significant = candidates
            .iter()
            .enumerate()
            .filter(|(_, cluster)| cluster.count >= minimum_accent_pixels)
            .collect::<Vec<_>>();
        let accent = significant
            .into_iter()
            .max_by(|(_, left), (_, right)| {
                accent_score(left, &selected, pixels.len()).total_cmp(&accent_score(
                    right,
                    &selected,
                    pixels.len(),
                ))
            })
            .map(|(index, _)| index)
            .unwrap_or(0);
        selected.push(candidates.remove(accent));
    }

    while selected.len() < 3 {
        selected.push(*selected.last()?);
    }

    Some(
        selected
            .into_iter()
            .map(|cluster| {
                let color = cluster.color;
                format!(
                    "#{:02x}{:02x}{:02x}",
                    color[0].round().clamp(0.0, 255.0) as u8,
                    color[1].round().clamp(0.0, 255.0) as u8,
                    color[2].round().clamp(0.0, 255.0) as u8,
                )
            })
            .collect(),
    )
}

#[derive(Clone, Copy)]
struct ColorCluster {
    count: usize,
    color: [f32; 3],
}

fn best_cluster_index(
    candidates: &[ColorCluster],
    selected: &[ColorCluster],
    score: impl Fn(f32, f32) -> f32,
) -> usize {
    let total = candidates
        .iter()
        .map(|cluster| cluster.count)
        .sum::<usize>()
        + selected.iter().map(|cluster| cluster.count).sum::<usize>();
    candidates
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            let cluster_score = |cluster: &ColorCluster| {
                let frequency = cluster.count as f32 / total as f32;
                let distance = normalized_nearest_distance(cluster.color, selected);
                score(frequency, distance)
            };
            cluster_score(left).total_cmp(&cluster_score(right))
        })
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn accent_score(cluster: &ColorCluster, selected: &[ColorCluster], total: usize) -> f32 {
    let frequency = (cluster.count as f32 / total as f32).powf(0.25);
    let diversity = normalized_nearest_distance(cluster.color, selected);
    frequency * diversity.powi(2)
}

fn normalized_nearest_distance(color: [f32; 3], selected: &[ColorCluster]) -> f32 {
    (selected
        .iter()
        .map(|cluster| color_distance(color, cluster.color))
        .fold(f32::INFINITY, f32::min)
        .sqrt()
        / 765.0)
        .clamp(0.0, 1.0)
}

fn nearest_color_distance(color: [f32; 3], centroids: &[[f32; 3]]) -> f32 {
    centroids
        .iter()
        .map(|centroid| color_distance(color, *centroid))
        .fold(f32::INFINITY, f32::min)
}

fn color_distance(left: [f32; 3], right: [f32; 3]) -> f32 {
    let red_mean = (left[0] + right[0]) * 0.5;
    let red = left[0] - right[0];
    let green = left[1] - right[1];
    let blue = left[2] - right[2];
    (2.0 + red_mean / 256.0) * red * red
        + 4.0 * green * green
        + (2.0 + (255.0 - red_mean) / 256.0) * blue * blue
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }

    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] {
        return None;
    }

    let mut index = 2;
    while index + 3 < bytes.len() {
        if bytes[index] != 0xff {
            index += 1;
            continue;
        }
        while index < bytes.len() && bytes[index] == 0xff {
            index += 1;
        }
        let marker = *bytes.get(index)?;
        index += 1;

        if marker == 0xd8 || marker == 0x01 {
            continue;
        }
        if marker == 0xd9 || marker == 0xda {
            break;
        }

        let length = u16::from_be_bytes([*bytes.get(index)?, *bytes.get(index + 1)?]) as usize;
        if length < 2 || index + length > bytes.len() {
            return None;
        }

        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) && length >= 7
        {
            let height = u16::from_be_bytes([bytes[index + 3], bytes[index + 4]]);
            let width = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]);
            return Some((u32::from(width), u32::from(height)));
        }

        index += length;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        ArtworkCandidate, dominant_colors, highest_resolution, image_dimensions, normalized_upc,
        qobuz_max_artwork_url, same_release_upc, trusted_artwork_url,
    };

    #[test]
    fn extracts_three_dominant_artwork_colors() {
        use std::io::Cursor;

        let mut image = image::RgbImage::new(30, 10);
        for (x, _, pixel) in image.enumerate_pixels_mut() {
            *pixel = if x < 15 {
                image::Rgb([210, 40, 30])
            } else if x < 24 {
                image::Rgb([20, 80, 190])
            } else {
                image::Rgb([235, 190, 40])
            };
        }
        let mut encoded = Cursor::new(Vec::new());
        image
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();

        let colors = dominant_colors(encoded.get_ref()).unwrap();
        assert_eq!(colors.len(), 3);
        let dominant_red = u8::from_str_radix(&colors[0][1..3], 16).unwrap();
        let dominant_green = u8::from_str_radix(&colors[0][3..5], 16).unwrap();
        let dominant_blue = u8::from_str_radix(&colors[0][5..7], 16).unwrap();
        assert!(dominant_red > dominant_green * 3);
        assert!(dominant_red > dominant_blue * 3);
    }

    #[test]
    fn preserves_a_small_but_distinct_accent_color() {
        use std::io::Cursor;

        let mut image = image::RgbImage::new(100, 100);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let index = y * 100 + x;
            *pixel = if index < 6_000 {
                image::Rgb([25, 145, 55])
            } else if index < 9_500 {
                image::Rgb([8, 10, 8])
            } else {
                image::Rgb([225, 30, 35])
            };
        }
        let mut encoded = Cursor::new(Vec::new());
        image
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();

        let colors = dominant_colors(encoded.get_ref()).unwrap();
        assert_eq!(colors.len(), 3);
        let accent = &colors[2];
        let red = u8::from_str_radix(&accent[1..3], 16).unwrap();
        let green = u8::from_str_radix(&accent[3..5], 16).unwrap();
        let blue = u8::from_str_radix(&accent[5..7], 16).unwrap();
        assert!(red > 180 && red > green * 3 && red > blue * 3);
    }

    #[test]
    fn matches_only_equivalent_gtin_padding() {
        assert!(same_release_upc("00724384559953", "724384559953"));
        assert!(!same_release_upc("00724384559953", "724384559954"));
        assert!(!same_release_upc("not-a-upc", "not-a-upc"));
        assert_eq!(
            normalized_upc(" 00724384559953 ").as_deref(),
            Some("724384559953")
        );
        assert_eq!(normalized_upc("00000000"), None);
    }

    #[test]
    fn requests_qobuz_max_without_changing_the_release_path() {
        assert_eq!(
            qobuz_max_artwork_url(
                "https://static.qobuz.com/images/covers/32/24/0634904032432_600.jpg"
            )
            .as_deref(),
            Some("https://static.qobuz.com/images/covers/32/24/0634904032432_max.jpg")
        );
        assert!(qobuz_max_artwork_url("https://example.com/cover_600.jpg").is_none());
    }

    #[test]
    fn accepts_only_known_provider_cdns() {
        assert!(trusted_artwork_url(
            "tidal",
            "https://resources.tidal.com/images/id/1280x1280.jpg"
        ));
        assert!(!trusted_artwork_url(
            "tidal",
            "https://static.qobuz.com/images/covers/id_600.jpg"
        ));
        assert!(!trusted_artwork_url("tidal", "http://127.0.0.1/private"));
    }

    #[test]
    fn selects_by_verified_pixel_count() {
        let source = ArtworkCandidate {
            provider: "tidal".into(),
            url: "tidal.jpg".into(),
            width: 1280,
            height: 1280,
            colors: Vec::new(),
        };
        let qobuz = ArtworkCandidate {
            provider: "qobuz".into(),
            url: "qobuz.jpg".into(),
            width: 4000,
            height: 4000,
            colors: Vec::new(),
        };

        assert_eq!(highest_resolution(source, [qobuz.clone()]), qobuz);
    }

    #[test]
    fn keeps_the_source_when_an_alternative_is_not_larger() {
        let source = ArtworkCandidate {
            provider: "tidal".into(),
            url: "tidal.jpg".into(),
            width: 1280,
            height: 1280,
            colors: Vec::new(),
        };
        let smaller = ArtworkCandidate {
            provider: "qobuz".into(),
            url: "qobuz.jpg".into(),
            width: 600,
            height: 600,
            colors: Vec::new(),
        };

        assert_eq!(highest_resolution(source.clone(), [smaller]), source);
    }

    #[test]
    fn reads_png_and_jpeg_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&4000_u32.to_be_bytes());
        png.extend_from_slice(&3000_u32.to_be_bytes());
        assert_eq!(image_dimensions(&png), Some((4000, 3000)));

        let jpeg = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x0f,
            0xa0, 0x0f, 0xa0, 0x03, 0x01, 0x11, 0x00,
        ];
        assert_eq!(image_dimensions(&jpeg), Some((4000, 4000)));
    }
}
