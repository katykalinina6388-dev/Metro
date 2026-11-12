// Запускающая программа игры «Поездной диспетчер».
//
// Все файлы игры встроены в исполняемый файл. Программа поднимает локальный веб-сервер
// (только на 127.0.0.1) и открывает игру в отдельном окне браузера Edge/Chrome/Яндекс,
// а если их нет — в браузере по умолчанию. Когда окно игры закрыто, программа завершается.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

//go:embed all:game
var assets embed.FS

const (
	appID       = "metro-dispatcher-nvl"
	defaultPort = 47833
)

var (
	mu       sync.Mutex
	clients  int
	everHad  bool
	lastGone = time.Now()
)

var types = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".gz": "application/gzip",
	".bin": "application/octet-stream", ".ogg": "audio/ogg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
}

func main() {
	port := flag.Int("port", defaultPort, "порт локального сервера")
	noBrowser := flag.Bool("no-browser", false, "не открывать окно браузера")
	dev := flag.String("dev", "", "раздавать файлы из каталога вместо встроенных (для разработки)")
	flag.Parse()

	var root fs.FS
	if *dev != "" {
		root = os.DirFS(*dev)
	} else {
		sub, err := fs.Sub(assets, "game")
		if err != nil {
			fatal("Не удалось открыть встроенные файлы игры: " + err.Error())
		}
		root = sub
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		// порт занят: либо игра уже запущена, либо его занял кто-то другой
		if isOurs(*port) {
			if !*noBrowser {
				openGame(fmt.Sprintf("http://127.0.0.1:%d/", *port))
			}
			return
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("Не удалось запустить локальный сервер игры: " + err.Error())
		}
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, appID) })
	mux.HandleFunc("/api/alive", alive)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { serve(root, w, r) })
	go watch(*noBrowser)
	if !*noBrowser {
		go func() {
			time.Sleep(150 * time.Millisecond)
			openGame(url)
		}()
	} else {
		fmt.Println(url)
	}
	if err := http.Serve(ln, mux); err != nil {
		fatal("Сервер игры остановлен: " + err.Error())
	}
}

func isOurs(port int) bool {
	c := http.Client{Timeout: 800 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	return string(b) == appID
}

func serve(root fs.FS, w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	f, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(path.Ext(name))
	ct, ok := types[ext]
	if !ok {
		ct = mime.TypeByExtension(ext)
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	rs, ok := f.(io.ReadSeeker)
	if ok {
		http.ServeContent(w, r, name, time.Time{}, rs)
		return
	}
	w.Header().Set("Content-Length", fmt.Sprint(st.Size()))
	io.Copy(w, f)
}

// alive — долгое соединение (Server-Sent Events) от открытой страницы игры.
func alive(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	mu.Lock()
	clients++
	everHad = true
	mu.Unlock()
	defer func() {
		mu.Lock()
		clients--
		lastGone = time.Now()
		mu.Unlock()
	}()
	fmt.Fprint(w, "retry: 1000\n\n")
	fl.Flush()
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-t.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// watch завершает программу, когда окно игры закрыто.
func watch(headless bool) {
	start := time.Now()
	for {
		time.Sleep(time.Second)
		mu.Lock()
		n, had, gone := clients, everHad, lastGone
		mu.Unlock()
		if had && n == 0 && time.Since(gone) > 20*time.Second {
			os.Exit(0)
		}
		if !had && !headless && time.Since(start) > 10*time.Minute {
			os.Exit(0)
		}
	}
}
