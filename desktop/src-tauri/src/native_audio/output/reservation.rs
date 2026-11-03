use std::{ffi::CString, sync::mpsc, thread, time::Duration};

use dbus::{
    blocking::{Connection, stdintf::org_freedesktop_dbus::RequestNameReply},
    channel::MatchingReceiver,
    message::MatchRule,
};
use dbus_crossroads::Crossroads;

const INTERFACE: &str = "org.freedesktop.ReserveDevice1";
const PRIORITY: i32 = i32::MAX;

/// Holding the reservation makes PipeWire/PulseAudio release the ALSA card. The
/// bus connection releases it on drop or process exit, so system audio resumes.
pub(super) struct DeviceReservation {
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl DeviceReservation {
    pub(super) fn for_device(id: &str) -> Result<Option<Self>, String> {
        let card = id
            .strip_prefix("hw:")
            .and_then(|id| id.split(',').next())
            .ok_or_else(|| format!("Invalid ALSA hardware device {id}"))?;
        let card = CString::new(card.strip_prefix("CARD=").unwrap_or(card))
            .map_err(|error| error.to_string())?;
        let card = alsa::Card::from_str(&card)
            .map_err(|error| format!("Could not locate ALSA card: {error}"))?;
        // Direct ALSA playback also works in sessions without a desktop audio server.
        let Ok(connection) = Connection::new_session() else {
            return Ok(None);
        };
        Self::acquire(connection, card.get_index()).map(Some)
    }

    fn acquire(connection: Connection, card: i32) -> Result<Self, String> {
        let name = format!("{INTERFACE}.Audio{card}");
        let path = format!("/org/freedesktop/ReserveDevice1/Audio{card}");
        let error = |error| format!("Could not reserve ALSA card {card}: {error}");
        let owned = |reply| {
            matches!(
                reply,
                RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner
            )
        };
        if !owned(
            connection
                .request_name(&name, false, false, true)
                .map_err(error)?,
        ) {
            let proxy = connection.with_proxy(&name, &path, Duration::from_secs(1));
            let released: Result<(bool,), _> =
                proxy.method_call(INTERFACE, "RequestRelease", (PRIORITY,));
            match released {
                Ok((true,)) => {}
                Ok((false,)) => {
                    return Err(format!(
                        "Another application refused exclusive control of ALSA card {card}"
                    ));
                }
                Err(failure)
                    if matches!(
                        failure.name(),
                        Some(
                            "org.freedesktop.DBus.Error.ServiceUnknown"
                                | "org.freedesktop.DBus.Error.NameHasNoOwner"
                        )
                    ) => {}
                Err(failure) => return Err(error(failure)),
            }
            if !owned(
                connection
                    .request_name(&name, false, true, true)
                    .map_err(error)?,
            ) {
                return Err(format!("Another application still owns ALSA card {card}"));
            }
        }

        let mut crossroads = Crossroads::new();
        let interface = crossroads.register(INTERFACE, |builder| {
            builder.property("Priority").get(|_, _| Ok(PRIORITY));
            builder
                .property("ApplicationName")
                .get(|_, _| Ok("AMBRA".to_owned()));
            builder
                .property("ApplicationDeviceName")
                .get(move |_, _| Ok(format!("Audio{card}")));
            // Explicit exclusive playback retains the card until the listener stops it.
            builder.method(
                "RequestRelease",
                ("priority",),
                ("released",),
                |_, _, (_priority,): (i32,)| Ok((false,)),
            );
        });
        crossroads.insert(path, &[interface], ());
        connection.start_receive(
            MatchRule::new_method_call(),
            Box::new(move |message, connection| {
                let _ = crossroads.handle_message(message, connection);
                true
            }),
        );
        let (stop, stopped) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("ambra-device-reservation".into())
            .spawn(move || {
                while matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                    if let Err(error) = connection.process(Duration::from_millis(25)) {
                        eprintln!("Audio device reservation ended: {error}");
                        break;
                    }
                }
                // Close the connection only after the PCM handle has closed.
            })
            .map_err(|failure| format!("Could not start device reservation: {failure}"))?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for DeviceReservation {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use std::sync::{
        Arc,
        atomic::{AtomicI32, Ordering},
    };

    struct Peer {
        stop: mpsc::Sender<()>,
        worker: Option<thread::JoinHandle<()>>,
        priority: Arc<AtomicI32>,
        owner: String,
    }

    impl Peer {
        fn start(card: i32, allow_release: bool) -> Self {
            let connection = Connection::new_session().unwrap();
            let name = format!("{INTERFACE}.Audio{card}");
            assert!(matches!(
                connection.request_name(&name, true, false, true).unwrap(),
                RequestNameReply::PrimaryOwner
            ));
            let owner = connection.unique_name().to_string();
            let priority = Arc::new(AtomicI32::new(-1));
            let requested = priority.clone();
            let mut crossroads = Crossroads::new();
            let interface = crossroads.register(INTERFACE, move |builder| {
                builder.method(
                    "RequestRelease",
                    ("priority",),
                    ("released",),
                    move |_, _, (priority,): (i32,)| {
                        requested.store(priority, Ordering::Relaxed);
                        Ok((allow_release,))
                    },
                );
            });
            crossroads.insert(
                format!("/org/freedesktop/ReserveDevice1/Audio{card}"),
                &[interface],
                (),
            );
            connection.start_receive(
                MatchRule::new_method_call(),
                Box::new(move |message, connection| {
                    let _ = crossroads.handle_message(message, connection);
                    true
                }),
            );
            let (stop, stopped) = mpsc::channel();
            let worker = thread::spawn(move || {
                while matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                    connection.process(Duration::from_millis(25)).unwrap();
                }
            });
            Self {
                stop,
                worker: Some(worker),
                priority,
                owner,
            }
        }
    }

    impl Drop for Peer {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(worker) = self.worker.take() {
                worker.join().unwrap();
            }
        }
    }

    #[test]
    #[ignore = "requires an isolated D-Bus session; run with dbus-run-session and --ignored"]
    fn device_reservation_takes_over_and_releases_on_drop() {
        let card = 999_001;
        let peer = Peer::start(card, true);
        let reservation =
            DeviceReservation::acquire(Connection::new_session().unwrap(), card).unwrap();
        assert_eq!(peer.priority.load(Ordering::Relaxed), PRIORITY);
        let connection = Connection::new_session().unwrap();
        let name = format!("{INTERFACE}.Audio{card}");
        let proxy = connection.with_proxy(
            &name,
            format!("/org/freedesktop/ReserveDevice1/Audio{card}"),
            Duration::from_secs(1),
        );
        let application: String = proxy.get(INTERFACE, "ApplicationName").unwrap();
        assert_eq!(application, "AMBRA");
        let (released,): (bool,) = proxy
            .method_call(INTERFACE, "RequestRelease", (0_i32,))
            .unwrap();
        assert!(!released);
        drop(reservation);
        assert!(matches!(
            connection.request_name(&name, false, false, true).unwrap(),
            RequestNameReply::PrimaryOwner
        ));
    }

    #[test]
    #[ignore = "requires an isolated D-Bus session; run with dbus-run-session and --ignored"]
    fn device_reservation_refusal_preserves_the_current_owner() {
        let card = 999_002;
        let peer = Peer::start(card, false);
        let failure = DeviceReservation::acquire(Connection::new_session().unwrap(), card)
            .err()
            .expect("Refused reservation must fail");
        assert!(failure.contains("refused exclusive control"));
        let connection = Connection::new_session().unwrap();
        let bus = connection.with_proxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            Duration::from_secs(1),
        );
        let (owner,): (String,) = bus
            .method_call(
                "org.freedesktop.DBus",
                "GetNameOwner",
                (format!("{INTERFACE}.Audio{card}"),),
            )
            .unwrap();
        assert_eq!(owner, peer.owner);
    }
}
