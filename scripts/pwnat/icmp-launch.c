/* Optional, one-shot ICMP socket launcher. No daemon, setuid bit, or sudo invocation.
 * Build: cc -O2 -Wall -Wextra -Werror icmp-launch.c -o icmp-launch
 * Linux: grant CAP_NET_RAW to a root-owned copy, never to Ambra or an interpreter.
 * macOS: the operator runs this explicitly with sudo in a private Terminal.
 * Only socket creation is privileged. The command runs as the invoking user,
 * with no process capabilities and one inherited IPv4 raw ICMP descriptor.
 */
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <unistd.h>
#include <grp.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef __linux__
#include <linux/capability.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#endif

static void fail(const char *what) { perror(what); exit(1); }

static unsigned long invoking_id(const char *name) {
    const char *value = getenv(name);
    char *end = NULL;
    if (!value || !*value || *value == '-') {
        fprintf(stderr, "Run through sudo as a non-root user; %s is missing\n", name);
        exit(1);
    }
    errno = 0;
    unsigned long result = strtoul(value, &end, 10);
    if (errno || *end || result == 0 || result > 0x7fffffffUL) {
        fprintf(stderr, "Invalid non-root invoking identity: %s\n", name);
        exit(1);
    }
    return result;
}

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') {
        fprintf(stderr, "Usage: icmp-launch /absolute/path/to/unprivileged-command [args...]\n");
        return 2;
    }
    uid_t uid = getuid();
    gid_t gid = getgid();
    if (geteuid() == 0) {
        uid = (uid_t)invoking_id("SUDO_UID");
        gid = (gid_t)invoking_id("SUDO_GID");
    }
    int fd = socket(AF_INET, SOCK_RAW, IPPROTO_ICMP);
    if (fd < 0) fail("IPv4 raw ICMP: Linux needs CAP_NET_RAW; macOS needs manual sudo for this launcher");
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
#ifdef __APPLE__
    address.sin_len = sizeof address;
#endif
    if (bind(fd, (struct sockaddr *)&address, sizeof address) < 0) fail("bind ICMP");
    if (fcntl(fd, F_SETFD, 0) < 0) fail("inherit ICMP descriptor");
    if (geteuid() == 0) {
        if (setgroups(0, NULL) || setgid(gid) || setuid(uid)) fail("drop root identity");
    }
#ifdef __linux__
    struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct data[2] = {{0}};
    if (syscall(SYS_capset, &header, &data) < 0) fail("drop capabilities");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("prevent privilege reacquisition");
#endif
    if (getuid() == 0 || geteuid() == 0 || getuid() != uid || getgid() != gid) {
        fprintf(stderr, "Refusing to run Ambra with a privileged identity\n");
        return 1;
    }
    char descriptor[32];
    snprintf(descriptor, sizeof descriptor, "%d", fd);
    if (setenv("AMBRA_PWNAT_ICMP_FD", descriptor, 1) < 0) fail("set descriptor");
    execv(argv[1], argv + 1);
    fail("exec unprivileged command");
}
