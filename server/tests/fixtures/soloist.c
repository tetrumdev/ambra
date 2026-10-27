/* Native test executable. No Spotify account, network, or audio hardware is used. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef AMBRA_FIXTURE_BUILD_TIMESTAMP
#error Define AMBRA_FIXTURE_BUILD_TIMESTAMP when compiling this test fixture
#endif
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char *data = NULL, *key = "";
    int pair = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--help")) {
            puts("--single-track --pair --ws --api-key --data-dir --cache-dir --cache-size --device-name --initial-volume");
            return 0;
        }
        if (!strcmp(argv[i], "--version")) {
            printf("soloist 1.3.10.20 build %ld (fixture)\n", (long)AMBRA_FIXTURE_BUILD_TIMESTAMP);
            return 0;
        }
        if (!strcmp(argv[i], "--data-dir") && i + 1 < argc) data = argv[++i];
        if (!strcmp(argv[i], "--api-key") && i + 1 < argc) key = argv[++i];
        if (!strcmp(argv[i], "--pair")) pair = 1;
    }
    if (!strcmp(key, "fixture-invalid-key")) { fprintf(stderr, "invalid API key: %s", key); return 1; }
    if (!strcmp(key, "fixture-expired-key")) return 10;
    if (pair && data) {
        char path[4096];
        snprintf(path, sizeof(path), "%s/settings", data); mkdir(path, 0700);
        snprintf(path, sizeof(path), "%s/settings/Users", data); mkdir(path, 0700);
        snprintf(path, sizeof(path), "%s/settings/Users/fixture-user", data); mkdir(path, 0700);
        snprintf(path, sizeof(path), "%s/settings/Users/fixture-user/prefs", data);
        FILE *file = fopen(path, "w"); if (!file) return 1;
        fputs("fixture.session=preserved\n", file); fclose(file);
        return 0;
    }
    sleep(30);
    return 0;
}
