// Server-only Core Audio process tap. No system-wide tap or hardware output device.
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#include <stdatomic.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// One producer (Core Audio) and one consumer (Rust). Fixed 256 KiB PCM bound.
#define SAMPLE_CAPACITY 65536u
#define CAPTURE_FORMAT_ERROR (-10001)
#define CAPTURE_OVERFLOW (-10002)
#define CAPTURE_TARGET_ERROR (-10003)
typedef struct {
    AudioObjectID tap;
    AudioObjectID aggregate;
    AudioObjectID process;
    AudioDeviceIOProcID callback;
    pid_t pid;
    AudioStreamBasicDescription format;
    atomic_size_t written;
    atomic_size_t consumed;
    atomic_bool delivering;
    atomic_int failure;
    int32_t samples[SAMPLE_CAPACITY];
} AmbraTap;

static AudioObjectPropertyAddress property(AudioObjectPropertySelector selector) {
    return (AudioObjectPropertyAddress){selector, kAudioObjectPropertyScopeGlobal,
                                      kAudioObjectPropertyElementMain};
}
static OSStatus get_property(AudioObjectID object, AudioObjectPropertySelector selector,
                             UInt32 size, void *value) {
    AudioObjectPropertyAddress address = property(selector);
    return AudioObjectGetPropertyData(object, &address, 0, NULL, &size, value);
}
int ambra_tap_available(void) {
    if (@available(macOS 14.2, *)) return 1;
    return 0;
}
uint32_t ambra_tap_process(uint32_t pid) {
    if (@available(macOS 14.2, *)) {
        AudioObjectID process = kAudioObjectUnknown;
        AudioObjectPropertyAddress address = property(kAudioHardwarePropertyTranslatePIDToProcessObject);
        UInt32 size = sizeof(process);
        pid_t target = (pid_t)pid;
        OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address,
                                                    sizeof(target), &target, &size, &process);
        return status == noErr ? process : kAudioObjectUnknown;
    }
    return kAudioObjectUnknown;
}
static int32_t pcm_float(float sample) {
    if (!isfinite(sample)) return 0;
    if (sample >= 1.0f) return INT32_MAX;
    if (sample <= -1.0f) return INT32_MIN;
    return (int32_t)((double)sample * 2147483648.0);
}
// No allocation, locks, logging, property queries, or blocking in this callback.
static OSStatus audio_input(AudioObjectID device, const AudioTimeStamp *now,
                            const AudioBufferList *input, const AudioTimeStamp *input_time,
                            AudioBufferList *output, const AudioTimeStamp *output_time, void *context) {
    (void)device; (void)now; (void)input_time; (void)output; (void)output_time;
    AmbraTap *tap = context;
    if (!atomic_load_explicit(&tap->delivering, memory_order_acquire) ||
        atomic_load_explicit(&tap->failure, memory_order_relaxed)) return noErr;
    bool planar = (tap->format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    UInt32 buffers = planar ? 2 : 1;
    if (!input || input->mNumberBuffers != buffers) goto format_error;
    UInt32 channels = planar ? 1 : 2;
    UInt32 size = input->mBuffers[0].mDataByteSize;
    if (size % (channels * 4) != 0) goto format_error;
    size_t frames = size / (channels * 4);
    for (UInt32 i = 0; i < buffers; i++) {
        if (input->mBuffers[i].mNumberChannels != channels ||
            input->mBuffers[i].mDataByteSize != size || !input->mBuffers[i].mData) goto format_error;
    }
    size_t written = atomic_load_explicit(&tap->written, memory_order_relaxed);
    size_t consumed = atomic_load_explicit(&tap->consumed, memory_order_acquire);
    if (frames > SAMPLE_CAPACITY / 2 || written - consumed > SAMPLE_CAPACITY - frames * 2) {
        atomic_store_explicit(&tap->failure, CAPTURE_OVERFLOW, memory_order_release);
        return noErr;
    }
    bool floating = (tap->format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    for (size_t frame = 0; frame < frames; frame++) {
        for (size_t channel = 0; channel < 2; channel++) {
            const void *data = input->mBuffers[planar ? channel : 0].mData;
            size_t index = planar ? frame : frame * 2 + channel;
            int32_t value;
            if (floating) value = pcm_float(((const float *)data)[index]);
            else value = ((const int32_t *)data)[index];
            tap->samples[(written + frame * 2 + channel) % SAMPLE_CAPACITY] = value;
        }
    }
    atomic_store_explicit(&tap->written, written + frames * 2, memory_order_release);
    return noErr;
format_error:
    atomic_store_explicit(&tap->failure, CAPTURE_FORMAT_ERROR, memory_order_release);
    return noErr;
}
void ambra_tap_close(AmbraTap *tap) {
    if (!tap) return;
    atomic_store_explicit(&tap->delivering, false, memory_order_release);
    if (tap->aggregate && tap->callback) {
        AudioDeviceStop(tap->aggregate, tap->callback);
        // Destroy waits for outstanding callbacks before ring memory is freed.
        AudioDeviceDestroyIOProcID(tap->aggregate, tap->callback);
    }
    if (tap->aggregate) AudioHardwareDestroyAggregateDevice(tap->aggregate);
    if (@available(macOS 14.2, *)) {
        if (tap->tap) AudioHardwareDestroyProcessTap(tap->tap);
    }
    free(tap);
}
AmbraTap *ambra_tap_open(uint32_t pid, int32_t *error) {
    *error = CAPTURE_TARGET_ERROR;
    if (!ambra_tap_available()) return NULL;
    AmbraTap *tap = calloc(1, sizeof(*tap));
    if (!tap) return NULL;
    atomic_init(&tap->written, 0);
    atomic_init(&tap->consumed, 0);
    atomic_init(&tap->delivering, false);
    atomic_init(&tap->failure, 0);
    tap->pid = (pid_t)pid;
    tap->process = ambra_tap_process(pid);
    if (!tap->process) { free(tap); return NULL; }
    @autoreleasepool {
        if (@available(macOS 14.2, *)) {
            CATapDescription *description = [[CATapDescription alloc]
                initStereoMixdownOfProcesses:@[@(tap->process)]];
            description.name = @"Ambra Soloist private capture";
            description.privateTap = YES;
            description.exclusive = NO;
            // Captured samples remain unmuted; physical output stays muted even during pre-roll.
            description.muteBehavior = CATapMuted;
            OSStatus status = AudioHardwareCreateProcessTap(description, &tap->tap);
            if (status != noErr) { *error = status; goto failed; }
            status = get_property(tap->tap, kAudioTapPropertyFormat,
                                  sizeof(tap->format), &tap->format);
            if (status != noErr) { *error = status; goto failed; }
            AudioStreamBasicDescription f = tap->format;
            bool float32 = (f.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
            bool signed32 = (f.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
            if (f.mFormatID != kAudioFormatLinearPCM || f.mSampleRate != 44100.0 ||
                f.mChannelsPerFrame != 2 || f.mBitsPerChannel != 32 ||
                (!float32 && !signed32) ||
                (f.mFormatFlags & kAudioFormatFlagIsBigEndian) ||
                !(f.mFormatFlags & kAudioFormatFlagIsPacked)) {
                *error = CAPTURE_FORMAT_ERROR; goto failed;
            }
            CFStringRef tap_uid = NULL;
            status = get_property(tap->tap, kAudioTapPropertyUID, sizeof(tap_uid), &tap_uid);
            if (status != noErr || !tap_uid) { *error = status; goto failed; }
            NSString *uid = CFBridgingRelease(tap_uid);
            NSDictionary *aggregate = @{
                @kAudioAggregateDeviceNameKey: @"Ambra Soloist private input",
                @kAudioAggregateDeviceUIDKey: [NSUUID UUID].UUIDString,
                @kAudioAggregateDeviceIsPrivateKey: @YES,
                @kAudioAggregateDeviceIsStackedKey: @NO,
                @kAudioAggregateDeviceTapAutoStartKey: @NO,
                @kAudioAggregateDeviceSubDeviceListKey: @[],
                @kAudioAggregateDeviceTapListKey: @[@{
                    @kAudioSubTapUIDKey: uid,
                    @kAudioSubTapDriftCompensationKey: @NO
                }]
            };
            status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate,
                                                        &tap->aggregate);
            if (status != noErr) { *error = status; goto failed; }
            status = AudioDeviceCreateIOProcID(tap->aggregate, audio_input, tap, &tap->callback);
            if (status != noErr) { *error = status; goto failed; }
            // macOS prompts for system audio recording permission here.
            status = AudioDeviceStart(tap->aggregate, tap->callback);
            if (status != noErr) { *error = status; goto failed; }
            *error = 0;
            return tap;
        }
    }
failed:
    ambra_tap_close(tap);
    return NULL;
}
int32_t ambra_tap_check(AmbraTap *tap, uint32_t pid) {
    int failure = atomic_load_explicit(&tap->failure, memory_order_acquire);
    if (failure) return failure;
    pid_t current_pid = 0;
    OSStatus status = get_property(tap->process, kAudioProcessPropertyPID,
                                  sizeof(current_pid), &current_pid);
    if (status != noErr || current_pid != (pid_t)pid || current_pid != tap->pid)
        return CAPTURE_TARGET_ERROR;
    AudioStreamBasicDescription current = {0};
    status = get_property(tap->tap, kAudioTapPropertyFormat, sizeof(current), &current);
    if (status != noErr || memcmp(&current, &tap->format, sizeof(current)) != 0)
        return CAPTURE_FORMAT_ERROR;
    UInt32 alive = 0;
    status = get_property(tap->aggregate, kAudioDevicePropertyDeviceIsAlive, sizeof(alive), &alive);
    if (status != noErr || !alive) return CAPTURE_TARGET_ERROR;
    return 0;
}
void ambra_tap_deliver(AmbraTap *tap) {
    atomic_store_explicit(&tap->delivering, true, memory_order_release);
}
size_t ambra_tap_read(AmbraTap *tap, uint8_t *destination, size_t capacity) {
    size_t consumed = atomic_load_explicit(&tap->consumed, memory_order_relaxed);
    size_t written = atomic_load_explicit(&tap->written, memory_order_acquire);
    size_t count = MIN(written - consumed, capacity / 4) & ~(size_t)1;
    for (size_t i = 0; i < count; i++) {
        uint32_t sample = (uint32_t)tap->samples[(consumed + i) % SAMPLE_CAPACITY];
        for (size_t byte = 0; byte < 4; byte++) destination[i * 4 + byte] = sample >> (byte * 8);
    }
    atomic_store_explicit(&tap->consumed, consumed + count, memory_order_release);
    return count * 4;
}
// Account-free verification exercises both native callback layouts and overflow behavior.
int ambra_tap_test_ring(void) {
    AmbraTap *tap = calloc(1, sizeof(*tap));
    if (!tap) return 0;
    atomic_init(&tap->written, 0); atomic_init(&tap->consumed, 0);
    atomic_init(&tap->delivering, false); atomic_init(&tap->failure, 0);
    tap->format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    float input[] = {-1.0f, 1.0f, 0.5f, -0.5f};
    AudioBufferList list = {.mNumberBuffers = 1, .mBuffers = {{2, sizeof(input), input}}};
    audio_input(0, NULL, &list, NULL, NULL, NULL, tap);
    int success = atomic_load(&tap->written) == 0;
    ambra_tap_deliver(tap);
    audio_input(0, NULL, &list, NULL, NULL, NULL, tap);
    uint8_t output[16];
    success &= ambra_tap_read(tap, output, 15) == 8 &&
                  output[3] == 0x80 && output[7] == 0x7f &&
                  ambra_tap_read(tap, output, 16) == 8 &&
                  output[3] == 0x40 && output[7] == 0xc0;
    // Exercise a noninterleaved native Float32 callback, then packed Int32.
    atomic_store(&tap->written, 0); atomic_store(&tap->consumed, 0);
    tap->format.mFormatFlags |= kAudioFormatFlagIsNonInterleaved;
    float left[] = {-0.5f, NAN}, right[] = {0.5f, INFINITY};
    struct { UInt32 count; AudioBuffer buffers[2]; } planar = {
        2, {{1, sizeof(left), left}, {1, sizeof(right), right}}
    };
    audio_input(0, NULL, (const AudioBufferList *)&planar, NULL, NULL, NULL, tap);
    success &= ambra_tap_read(tap, output, 16) == 16 &&
               output[3] == 0xc0 && output[7] == 0x40 &&
               output[8] == 0 && output[12] == 0;
    atomic_store(&tap->written, 0); atomic_store(&tap->consumed, 0);
    tap->format.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    int32_t integers[] = {INT32_MIN, INT32_MAX};
    AudioBufferList packed = {.mNumberBuffers = 1, .mBuffers = {{2, sizeof(integers), integers}}};
    audio_input(0, NULL, &packed, NULL, NULL, NULL, tap);
    success &= ambra_tap_read(tap, output, 16) == 8 && output[3] == 0x80 && output[7] == 0x7f;
    atomic_store(&tap->written, SAMPLE_CAPACITY);
    atomic_store(&tap->consumed, 0);
    audio_input(0, NULL, &list, NULL, NULL, NULL, tap);
    success &= atomic_load(&tap->failure) == CAPTURE_OVERFLOW;
    atomic_store(&tap->failure, 0);
    packed.mBuffers[0].mNumberChannels = 1;
    audio_input(0, NULL, &packed, NULL, NULL, NULL, tap);
    success &= atomic_load(&tap->failure) == CAPTURE_FORMAT_ERROR;
    free(tap);
    return success;
}
