"""Apply the application's public Wi-Fi initialization wrapper, without SDK edits."""
Import('env')
env.AppendUnique(LINKFLAGS=['-Wl,--wrap=esp_wifi_init'])
