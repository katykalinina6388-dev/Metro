//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

// openGame открывает игру отдельным окном (режим приложения) в браузере на движке Chromium.
func openGame(url string) {
	local := os.Getenv("LOCALAPPDATA")
	pf, pf86 := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")
	candidates := []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(local, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(local, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(local, `Yandex\YandexBrowser\Application\browser.exe`),
	}
	profile := filepath.Join(local, "MetroDispatcher", "profile")
	if local == "" {
		profile = filepath.Join(os.TempDir(), "MetroDispatcher", "profile")
	}
	for _, exe := range candidates {
		if st, err := os.Stat(exe); err != nil || st.IsDir() {
			continue
		}
		os.MkdirAll(profile, 0o755)
		cmd := exec.Command(exe,
			"--app="+url,
			"--user-data-dir="+profile,
			"--no-first-run", "--no-default-browser-check",
			"--autoplay-policy=no-user-gesture-required",
			"--disable-features=Translate",
			"--start-maximized",
		)
		if cmd.Start() == nil {
			go cmd.Wait()
			return
		}
	}
	// подходящего браузера нет — открыть в браузере по умолчанию
	if exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start() != nil {
		fatal("Не удалось открыть браузер. Откройте вручную адрес: " + url)
	}
}

func fatal(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	t, _ := syscall.UTF16PtrFromString("Поездной диспетчер")
	m, _ := syscall.UTF16PtrFromString(msg)
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
	os.Exit(1)
}
