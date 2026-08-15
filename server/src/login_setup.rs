use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
};

const RESET_COMMAND: &str = "reset-logins";

pub enum Command {
    RunServer,
    ResetLogins,
}

pub fn command() -> io::Result<Command> {
    let mut arguments = env::args().skip(1);
    match (arguments.next().as_deref(), arguments.next()) {
        (None, None) => Ok(Command::RunServer),
        (Some(RESET_COMMAND), None) => Ok(Command::ResetLogins),
        (Some(argument), _) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Unknown command '{argument}'. Use `cargo run` or `cargo run -- {RESET_COMMAND}`."
            ),
        )),
        (None, Some(_)) => unreachable!(),
    }
}

pub fn setup_needed() -> bool {
    !setup_marker_path().is_file()
}

pub fn ask_to_log_in(provider: &str) -> io::Result<bool> {
    print!("Log in to {provider} now? [y/N]: ");
    io::stdout().flush()?;

    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(is_yes(&answer))
}

pub fn finish_setup() -> io::Result<()> {
    fs::write(setup_marker_path(), b"complete\n")
}

pub fn reset() -> io::Result<()> {
    match fs::remove_file(setup_marker_path()) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    println!("Login setup reset. Run `cargo run` to choose any services that are not logged in.");
    Ok(())
}

fn setup_marker_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".login-setup-complete")
}

fn is_yes(answer: &str) -> bool {
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

#[cfg(test)]
mod tests {
    use super::is_yes;

    #[test]
    fn accepts_only_clear_yes_answers() {
        assert!(is_yes("y"));
        assert!(is_yes(" YES \n"));
        assert!(!is_yes(""));
        assert!(!is_yes("no"));
    }
}
