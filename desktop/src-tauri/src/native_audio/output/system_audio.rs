//! Park displaced desktop audio on a null sink before reserving an ALSA card.
use std::{
    collections::HashMap,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

static NEXT_SINK: AtomicU64 = AtomicU64::new(1);

trait Control {
    fn run(&self, args: &[&str]) -> Result<String, String>;
    fn json(&self, args: &[&str]) -> Result<Value, String> {
        serde_json::from_str(&self.run(args)?).map_err(|error| error.to_string())
    }
}

struct Pulse;

impl Control for Pulse {
    fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut command = Command::new("pactl");
        if matches!(args.first(), Some(&"list" | &"info")) {
            command.args(["-f", "json"]);
        }
        let output = command
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| format!("Could not control system audio: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not {} for exclusive playback",
                args.first().unwrap_or(&"inspect system audio")
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
}

struct Route {
    card: String,
    sinks: Vec<Value>,
    streams: HashMap<u64, String>,
    default: Option<String>,
    name: String,
    module: String,
}

impl Route {
    fn prepare(
        control: &impl Control,
        card: &str,
        mixer_owns_card: bool,
    ) -> Result<Option<Self>, String> {
        let sinks = match control.json(&["list", "sinks"]) {
            Ok(sinks) => sinks,
            Err(error) if mixer_owns_card => return Err(error),
            Err(_) => return Ok(None), // Direct ALSA sessions may have no system mixer.
        };
        let sinks: Vec<_> = sinks
            .as_array()
            .ok_or("Could not inspect system audio outputs")?
            .iter()
            .filter(|sink| {
                sink.pointer("/properties/alsa.id").and_then(Value::as_str) == Some(card)
            })
            .cloned()
            .collect();
        if sinks.is_empty() {
            if mixer_owns_card {
                return Err("Could not identify system audio routes for exclusive playback".into());
            }
            return Ok(None);
        }
        let info = control.json(&["info"])?;
        let default = info["default_sink_name"]
            .as_str()
            .ok_or("Could not inspect the default audio output")?;
        let default = sinks
            .iter()
            .any(|sink| sink["name"].as_str() == Some(default))
            .then(|| default.to_owned());
        let inputs = control.json(&["list", "sink-inputs"])?;
        let mut streams = HashMap::new();
        for input in inputs
            .as_array()
            .ok_or("Could not inspect system audio streams")?
        {
            if let Some(sink) = sinks
                .iter()
                .find(|sink| sink["index"].as_u64() == input["sink"].as_u64())
            {
                streams.insert(
                    input["index"].as_u64().ok_or("Missing audio stream ID")?,
                    sink["name"]
                        .as_str()
                        .ok_or("Missing audio output name")?
                        .to_owned(),
                );
            }
        }
        let name = format!(
            "ambra_exclusive_{}_{}",
            std::process::id(),
            NEXT_SINK.fetch_add(1, Ordering::Relaxed)
        );
        let module = control.run(&[
            "load-module",
            "module-null-sink",
            &format!("sink_name={name}"),
            "sink_properties=device.description='AMBRA Exclusive (silent)'",
            "channels=2",
        ])?;
        module
            .parse::<u32>()
            .map_err(|_| "Could not identify the silent audio device")?;
        let route = Self {
            card: card.to_owned(),
            sinks,
            streams,
            default,
            name,
            module,
        };
        let configured = (|| {
            if route.default.is_some() {
                control.run(&["set-default-sink", &route.name])?;
            }
            for stream in route.streams.keys() {
                // A stream can close between inspection and the move.
                if control
                    .run(&["move-sink-input", &stream.to_string(), &route.name])
                    .is_err()
                {
                    let inputs = control.json(&["list", "sink-inputs"])?;
                    if inputs.as_array().is_none_or(|inputs| {
                        inputs
                            .iter()
                            .any(|input| input["index"].as_u64() == Some(*stream))
                    }) {
                        return Err(
                            "Could not silence a system audio stream before exclusive playback"
                                .into(),
                        );
                    }
                }
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = configured {
            let _ = route.restore(control);
            return Err(error);
        }
        Ok(Some(route))
    }

    fn restored_sink<'a>(&self, saved_name: &str, sinks: &'a [Value]) -> Option<&'a Value> {
        let saved = self
            .sinks
            .iter()
            .find(|sink| sink["name"].as_str() == Some(saved_name))?;
        sinks.iter().find(|sink| {
            sink["properties"]["alsa.id"].as_str() == Some(&self.card)
                && sink["properties"]["alsa.device"] == saved["properties"]["alsa.device"]
        })
    }

    /// False leaves audio safely parked while the hardware node is being recreated.
    fn restore(&self, control: &impl Control) -> Result<bool, String> {
        let listing = control.json(&["list", "sinks"])?;
        let sinks = listing
            .as_array()
            .ok_or("Could not inspect returning audio outputs")?;
        let Some(silent) = sinks
            .iter()
            .find(|sink| sink["name"].as_str() == Some(&self.name))
        else {
            return Ok(true);
        };
        for saved in &self.sinks {
            let saved_name = saved["name"]
                .as_str()
                .ok_or("Missing original audio output name")?;
            let Some(restored) = self.restored_sink(saved_name, sinks) else {
                return Ok(false);
            };
            if restored["index"] != saved["index"] {
                // Restore the listener's level before any parked streams can become audible.
                if let Some(volume) = saved["volume"].as_object() {
                    let values: Vec<_> = volume
                        .values()
                        .filter_map(|channel| channel["value"].as_u64())
                        .map(|value| value.to_string())
                        .collect();
                    let mut args = vec![
                        "set-sink-volume",
                        restored["name"]
                            .as_str()
                            .ok_or("Missing returning output name")?,
                    ];
                    args.extend(values.iter().map(String::as_str));
                    control.run(&args)?;
                }
                if let Some(mute) = saved["mute"].as_bool() {
                    control.run(&[
                        "set-sink-mute",
                        restored["name"].as_str().unwrap(),
                        if mute { "1" } else { "0" },
                    ])?;
                }
            }
        }
        let inputs = control.json(&["list", "sink-inputs"])?;
        for input in inputs
            .as_array()
            .ok_or("Could not inspect parked audio streams")?
        {
            if input["sink"] != silent["index"] {
                continue;
            }
            let stream = input["index"].as_u64().ok_or("Missing parked stream ID")?;
            let saved_name = self
                .streams
                .get(&stream)
                .map(String::as_str)
                .or(self.default.as_deref())
                .or_else(|| self.sinks.first()?.get("name")?.as_str())
                .ok_or("Missing original audio output")?;
            let destination = self
                .restored_sink(saved_name, sinks)
                .ok_or("Original audio output has not returned")?;
            if control
                .run(&[
                    "move-sink-input",
                    &stream.to_string(),
                    destination["name"].as_str().unwrap(),
                ])
                .is_err()
            {
                let current = control.json(&["list", "sink-inputs"])?;
                if current.as_array().is_none_or(|inputs| {
                    inputs
                        .iter()
                        .any(|input| input["index"].as_u64() == Some(stream))
                }) {
                    return Ok(false);
                }
            }
        }
        if let Some(default) = &self.default {
            let info = control.json(&["info"])?;
            // An explicit output change made during playback belongs to the listener.
            if info["default_sink_name"].as_str() == Some(&self.name) {
                let destination = self
                    .restored_sink(default, sinks)
                    .ok_or("Default audio output has not returned")?;
                control.run(&["set-default-sink", destination["name"].as_str().unwrap()])?;
            }
        }
        control.run(&["unload-module", &self.module])?;
        Ok(true)
    }
}

pub(super) struct SilentSystemAudio(Route);

impl SilentSystemAudio {
    pub(super) fn for_device(id: &str, mixer_owns_card: bool) -> Result<Option<Self>, String> {
        let Some((card, _)) = id
            .strip_prefix("hw:CARD=")
            .and_then(|id| id.split_once(",DEV="))
        else {
            return Ok(None);
        };
        Route::prepare(&Pulse, card, mixer_owns_card).map(|route| route.map(Self))
    }
}

impl Drop for SilentSystemAudio {
    fn drop(&mut self) {
        // Run synchronously so a format change cannot open another exclusive stream
        // before this output has restored its routes, and app shutdown cleans up too.
        let started = Instant::now();
        loop {
            match self.0.restore(&Pulse) {
                Ok(true) => return,
                _ if started.elapsed() < Duration::from_secs(10) => {
                    thread::sleep(Duration::from_millis(100))
                }
                _ => {
                    eprintln!(
                        "System audio remains on AMBRA's silent sink because its original output has not returned"
                    );
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    struct State {
        sinks: Vec<Value>,
        inputs: Vec<Value>,
        default: String,
        calls: Vec<Vec<String>>,
        fail_move: bool,
        offline: bool,
    }

    struct Mixer(RefCell<State>);

    fn hardware(index: u64, name: &str, card: &str) -> Value {
        json!({ "index": index, "name": name, "properties": { "alsa.id": card, "alsa.device": "0" },
            "volume": { "left": { "value": 45000 }, "right": { "value": 45000 } }, "mute": false })
    }

    impl Mixer {
        fn new() -> Self {
            Self(RefCell::new(State {
                sinks: vec![
                    hardware(10, "headphones", "DAC"),
                    hardware(20, "speakers", "PCH"),
                ],
                inputs: vec![
                    json!({ "index": 1, "sink": 10 }),
                    json!({ "index": 2, "sink": 20 }),
                ],
                default: "headphones".into(),
                calls: Vec::new(),
                fail_move: false,
                offline: false,
            }))
        }

        fn return_headphones(&self) {
            let mut state = self.0.borrow_mut();
            state.sinks.retain(|sink| sink["index"] != 10);
            state.sinks.push(hardware(60, "headphones-returned", "DAC"));
        }
    }

    impl Control for Mixer {
        fn run(&self, args: &[&str]) -> Result<String, String> {
            let mut state = self.0.borrow_mut();
            state
                .calls
                .push(args.iter().map(|arg| arg.to_string()).collect());
            if state.offline {
                return Err("Mixer unavailable".into());
            }
            match args {
                ["list", "sinks"] => Ok(json!(state.sinks).to_string()),
                ["list", "sink-inputs"] => Ok(json!(state.inputs).to_string()),
                ["info"] => Ok(json!({ "default_sink_name": state.default }).to_string()),
                ["load-module", "module-null-sink", name, ..] => {
                    state.sinks.push(
                        json!({ "index": 30, "name": name.strip_prefix("sink_name=").unwrap() }),
                    );
                    Ok("99".into())
                }
                ["unload-module", "99"] => {
                    state.sinks.retain(|sink| sink["index"] != 30);
                    Ok(String::new())
                }
                ["set-default-sink", name] => {
                    state.default = name.to_string();
                    Ok(String::new())
                }
                ["move-sink-input", index, name] => {
                    if state.fail_move {
                        return Err("Move failed".into());
                    }
                    let sink = state
                        .sinks
                        .iter()
                        .find(|sink| sink["name"] == *name)
                        .unwrap()["index"]
                        .clone();
                    let index: u64 = index.parse().unwrap();
                    state
                        .inputs
                        .iter_mut()
                        .find(|input| input["index"] == index)
                        .unwrap()["sink"] = sink;
                    Ok(String::new())
                }
                ["set-sink-volume", ..] | ["set-sink-mute", ..] => Ok(String::new()),
                _ => panic!("Unexpected audio command: {args:?}"),
            }
        }
    }

    #[test]
    fn exclusive_playback_parks_only_displaced_audio_before_the_card_disappears() {
        let mixer = Mixer::new();
        let route = Route::prepare(&mixer, "DAC", true).unwrap().unwrap();
        let state = mixer.0.borrow();
        assert_eq!(state.default, route.name);
        assert_eq!(state.inputs[0]["sink"], 30);
        assert_eq!(state.inputs[1]["sink"], 20);
        assert_eq!(
            state
                .sinks
                .iter()
                .filter(|sink| sink["name"] == route.name)
                .count(),
            1
        );
    }

    #[test]
    fn restoration_waits_for_hardware_then_restores_old_and_new_streams_at_saved_volume() {
        let mixer = Mixer::new();
        let route = Route::prepare(&mixer, "DAC", true).unwrap().unwrap();
        {
            let mut state = mixer.0.borrow_mut();
            state.sinks.retain(|sink| sink["index"] != 10);
            state.inputs.push(json!({ "index": 3, "sink": 30 }));
        }
        assert!(!route.restore(&mixer).unwrap());
        assert_eq!(mixer.0.borrow().default, route.name);
        mixer.return_headphones();
        assert!(route.restore(&mixer).unwrap());
        let state = mixer.0.borrow();
        assert_eq!(state.default, "headphones-returned");
        assert_eq!(state.inputs[0]["sink"], 60);
        assert_eq!(state.inputs[1]["sink"], 20);
        assert_eq!(state.inputs[2]["sink"], 60);
        assert!(!state.sinks.iter().any(|sink| sink["index"] == 30));
        let volume = state
            .calls
            .iter()
            .position(|args| args[0] == "set-sink-volume")
            .unwrap();
        let resumed = state
            .calls
            .iter()
            .position(|args| args[0] == "move-sink-input" && args[2] == "headphones-returned")
            .unwrap();
        assert!(volume < resumed);
        assert_eq!(
            state.calls[volume],
            ["set-sink-volume", "headphones-returned", "45000", "45000"]
        );
    }

    #[test]
    fn manual_default_and_stream_changes_are_preserved() {
        let mixer = Mixer::new();
        let route = Route::prepare(&mixer, "DAC", true).unwrap().unwrap();
        {
            let mut state = mixer.0.borrow_mut();
            state.default = "speakers".into();
            state.inputs[0]["sink"] = json!(20);
        }
        mixer.return_headphones();
        assert!(route.restore(&mixer).unwrap());
        assert_eq!(mixer.0.borrow().default, "speakers");
        assert_eq!(mixer.0.borrow().inputs[0]["sink"], 20);
    }

    #[test]
    fn a_nondefault_exclusive_output_does_not_change_the_listeners_other_default() {
        let mixer = Mixer::new();
        mixer.0.borrow_mut().default = "speakers".into();
        let route = Route::prepare(&mixer, "DAC", true).unwrap().unwrap();
        assert_eq!(mixer.0.borrow().default, "speakers");
        assert_eq!(mixer.0.borrow().inputs[0]["sink"], 30);
        assert!(route.restore(&mixer).unwrap());
        assert_eq!(mixer.0.borrow().default, "speakers");
    }

    #[test]
    fn failed_stream_move_restores_default_and_removes_the_temporary_sink() {
        let mixer = Mixer::new();
        mixer.0.borrow_mut().fail_move = true;
        assert!(Route::prepare(&mixer, "DAC", true).is_err());
        let state = mixer.0.borrow();
        assert_eq!(state.default, "headphones");
        assert_eq!(state.inputs[0]["sink"], 10);
        assert_eq!(state.sinks.len(), 2);
    }

    #[test]
    fn missing_mixer_is_optional_only_when_it_does_not_own_the_device() {
        let mixer = Mixer::new();
        mixer.0.borrow_mut().offline = true;
        assert!(Route::prepare(&mixer, "DAC", false).unwrap().is_none());
        assert!(Route::prepare(&mixer, "DAC", true).is_err());
    }

    #[test]
    fn failed_hardware_open_can_restore_unchanged_routes_immediately() {
        let mixer = Mixer::new();
        let route = Route::prepare(&mixer, "DAC", true).unwrap().unwrap();
        assert!(route.restore(&mixer).unwrap());
        assert_eq!(mixer.0.borrow().default, "headphones");
        assert_eq!(mixer.0.borrow().inputs[0]["sink"], 10);
        assert_eq!(mixer.0.borrow().sinks.len(), 2);
    }

    /// Only temporary null sinks receive synthetic silence; no hardware is reserved.
    #[test]
    #[ignore = "requires a running PulseAudio-compatible server and pacat"]
    fn live_null_sink_parks_and_restores_a_synthetic_stream() {
        struct Cleanup {
            modules: Vec<String>,
            stream: Option<std::process::Child>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Some(child) = self.stream.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                for module in self.modules.iter().rev() {
                    let _ = Pulse.run(&["unload-module", module]);
                }
            }
        }
        let mut cleanup = Cleanup {
            modules: Vec::new(),
            stream: None,
        };
        let default = Pulse.json(&["info"]).unwrap()["default_sink_name"]
            .as_str()
            .unwrap()
            .to_owned();
        let card = format!("AMBRA_ROUTING_TEST_{}", std::process::id());
        let name = format!("ambra_routing_test_{}", std::process::id());
        let properties = format!(
            "sink_properties='alsa.id={card} alsa.device=0 priority.session=0 device.description=AMBRA_Routing_Test'"
        );
        let original_module = Pulse
            .run(&[
                "load-module",
                "module-null-sink",
                &format!("sink_name={name}"),
                &properties,
            ])
            .unwrap();
        cleanup.modules.push(original_module.clone());
        cleanup.stream = Some(
            Command::new("pacat")
                .args([
                    "--playback",
                    "--raw",
                    "--rate=48000",
                    "--channels=2",
                    "--format=s16le",
                    &format!("--device={name}"),
                ])
                .stdin(std::fs::File::open("/dev/zero").unwrap())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut stream = None;
        for _ in 0..50 {
            let sinks = Pulse.json(&["list", "sinks"]).unwrap();
            let sink = sinks
                .as_array()
                .unwrap()
                .iter()
                .find(|sink| sink["name"] == name)
                .unwrap()["index"]
                .clone();
            let inputs = Pulse.json(&["list", "sink-inputs"]).unwrap();
            stream = inputs
                .as_array()
                .unwrap()
                .iter()
                .find(|input| input["sink"] == sink)
                .map(|input| input["index"].clone());
            if stream.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let stream = stream.expect("Synthetic stream did not start");
        let route = Route::prepare(&Pulse, &card, true).unwrap().unwrap();
        cleanup.modules.push(route.module.clone());
        assert_eq!(Pulse.json(&["info"]).unwrap()["default_sink_name"], default);
        Pulse.run(&["unload-module", &original_module]).unwrap();
        let sinks = Pulse.json(&["list", "sinks"]).unwrap();
        let silent = sinks
            .as_array()
            .unwrap()
            .iter()
            .find(|sink| sink["name"] == route.name)
            .unwrap()["index"]
            .clone();
        let inputs = Pulse.json(&["list", "sink-inputs"]).unwrap();
        assert_eq!(
            inputs
                .as_array()
                .unwrap()
                .iter()
                .find(|input| input["index"] == stream)
                .unwrap()["sink"],
            silent
        );
        assert!(!route.restore(&Pulse).unwrap());
        let returned = format!("{name}_returned");
        cleanup.modules.push(
            Pulse
                .run(&[
                    "load-module",
                    "module-null-sink",
                    &format!("sink_name={returned}"),
                    &properties,
                ])
                .unwrap(),
        );
        assert!(route.restore(&Pulse).unwrap());
        let sinks = Pulse.json(&["list", "sinks"]).unwrap();
        let destination = sinks
            .as_array()
            .unwrap()
            .iter()
            .find(|sink| sink["name"] == returned)
            .unwrap()["index"]
            .clone();
        assert!(
            !sinks
                .as_array()
                .unwrap()
                .iter()
                .any(|sink| sink["name"] == route.name)
        );
        let inputs = Pulse.json(&["list", "sink-inputs"]).unwrap();
        assert_eq!(
            inputs
                .as_array()
                .unwrap()
                .iter()
                .find(|input| input["index"] == stream)
                .unwrap()["sink"],
            destination
        );
        assert_eq!(Pulse.json(&["info"]).unwrap()["default_sink_name"], default);
    }
}
