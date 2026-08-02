"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type LyricLine = { time: number; text: string };
type AudioGraph = {
  context: AudioContext;
  musicGain: GainNode;
  micGain: GainNode;
  monitorGain: GainNode;
  wetGain: GainNode;
  delay: DelayNode;
  analyser: AnalyserNode;
  recordDestination: MediaStreamAudioDestinationNode;
  micSource?: MediaStreamAudioSourceNode;
};

const starterLyrics: LyricLine[] = [
  { time: 0, text: "选一首你喜欢的伴奏" },
  { time: 4, text: "再导入 LRC 歌词，就可以开唱" },
  { time: 8, text: "戴上耳机，效果会更好" },
  { time: 12, text: "今晚，把这里变成你的舞台" },
];

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "00:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseLyrics(raw: string, duration: number): LyricLine[] {
  const timed: LyricLine[] = [];
  const plain: string[] = [];

  raw.split(/\r?\n/).forEach((row) => {
    const text = row.replace(/\[[^\]]+\]/g, "").trim();
    const timestamps = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (timestamps.length && text) {
      timestamps.forEach((match) => {
        const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
        timed.push({ time: Number(match[1]) * 60 + Number(match[2]) + fraction, text });
      });
    } else if (text && !/^\[(ar|ti|al|by|offset):/i.test(row)) {
      plain.push(text);
    }
  });

  if (timed.length) return timed.sort((a, b) => a.time - b.time);
  const usableDuration = duration > 0 ? duration : Math.max(plain.length * 5, 30);
  return plain.map((text, index) => ({
    time: plain.length === 1 ? 0 : (index / plain.length) * usableDuration,
    text,
  }));
}

export default function Home() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const lyricInputRef = useRef<HTMLInputElement>(null);
  const lyricsStageRef = useRef<HTMLDivElement>(null);
  const lyricRefs = useRef<Array<HTMLParagraphElement | null>>([]);
  const graphRef = useRef<AudioGraph | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const animationRef = useRef<number | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [songName, setSongName] = useState("还没有选择歌曲");
  const [audioUrl, setAudioUrl] = useState("");
  const [lyrics, setLyrics] = useState<LyricLine[]>(starterLyrics);
  const [lyricsDraft, setLyricsDraft] = useState("");
  const [showLyricsEditor, setShowLyricsEditor] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [musicVolume, setMusicVolume] = useState(76);
  const [micVolume, setMicVolume] = useState(82);
  const [echo, setEcho] = useState(28);
  const [monitoring, setMonitoring] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [meter, setMeter] = useState(0);
  const [toast, setToast] = useState("");

  const activeIndex = useMemo(() => {
    let found = 0;
    lyrics.forEach((line, index) => {
      if (line.time <= currentTime + 0.12) found = index;
    });
    return found;
  }, [lyrics, currentTime]);

  useEffect(() => {
    lyricRefs.current[activeIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const ensureGraph = useCallback(() => {
    if (graphRef.current) {
      if (graphRef.current.context.state === "suspended") void graphRef.current.context.resume();
      return graphRef.current;
    }
    const audio = audioRef.current;
    if (!audio) return null;
    const context = new AudioContext();
    const musicSource = context.createMediaElementSource(audio);
    const musicGain = context.createGain();
    const micGain = context.createGain();
    const monitorGain = context.createGain();
    const wetGain = context.createGain();
    const delay = context.createDelay(1);
    const feedback = context.createGain();
    const analyser = context.createAnalyser();
    const recordDestination = context.createMediaStreamDestination();

    musicGain.gain.value = musicVolume / 100;
    micGain.gain.value = micVolume / 100;
    monitorGain.gain.value = monitoring ? 1 : 0;
    wetGain.gain.value = echo / 100;
    delay.delayTime.value = 0.19;
    feedback.gain.value = 0.22;
    analyser.fftSize = 256;

    musicSource.connect(musicGain);
    musicGain.connect(context.destination);
    musicGain.connect(recordDestination);

    micGain.connect(analyser);
    micGain.connect(monitorGain);
    micGain.connect(recordDestination);
    micGain.connect(wetGain);
    wetGain.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(monitorGain);
    delay.connect(recordDestination);
    monitorGain.connect(context.destination);

    graphRef.current = { context, musicGain, micGain, monitorGain, wetGain, delay, analyser, recordDestination };
    return graphRef.current;
  }, [echo, micVolume, monitoring, musicVolume]);

  useEffect(() => {
    if (graphRef.current) graphRef.current.musicGain.gain.value = musicVolume / 100;
  }, [musicVolume]);
  useEffect(() => {
    if (graphRef.current) graphRef.current.micGain.gain.value = micVolume / 100;
  }, [micVolume]);
  useEffect(() => {
    if (graphRef.current) graphRef.current.wetGain.gain.value = echo / 100;
  }, [echo]);
  useEffect(() => {
    if (graphRef.current) graphRef.current.monitorGain.gain.value = monitoring ? 1 : 0;
  }, [monitoring]);

  useEffect(() => () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    void graphRef.current?.context.close();
  }, []);

  const startMeter = useCallback((analyser: AnalyserNode) => {
    const values = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      analyser.getByteFrequencyData(values);
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      setMeter(Math.min(100, average * 1.35));
      animationRef.current = requestAnimationFrame(draw);
    };
    draw();
  }, []);

  const enableMic = useCallback(async () => {
    setMicError("");
    try {
      const graph = ensureGraph();
      if (!graph) return false;
      if (!micStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        micStreamRef.current = stream;
        graph.micSource = graph.context.createMediaStreamSource(stream);
        graph.micSource.connect(graph.micGain);
        startMeter(graph.analyser);
      }
      setMicReady(true);
      setToast("麦克风已就位");
      return true;
    } catch {
      setMicError("无法使用麦克风，请在浏览器设置中允许权限。");
      return false;
    }
  }, [ensureGraph, startMeter]);

  const handleAudioFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setAudioUrl(url);
    setSongName(file.name.replace(/\.[^.]+$/, ""));
    setCurrentTime(0);
    setIsPlaying(false);
    setRecordingUrl("");
    setToast("伴奏已加入，准备开唱");
    event.target.value = "";
  };

  const handleLyricFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const raw = await file.text();
    const parsed = parseLyrics(raw, duration);
    if (parsed.length) {
      setLyrics(parsed);
      setLyricsDraft(raw);
      setToast(`已加入 ${parsed.length} 句歌词`);
    }
    event.target.value = "";
  };

  const applyLyrics = () => {
    const parsed = parseLyrics(lyricsDraft, duration);
    if (!parsed.length) {
      setToast("请先输入几句歌词");
      return;
    }
    setLyrics(parsed);
    setShowLyricsEditor(false);
    setToast("歌词已更新");
  };

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audioUrl || !audio) {
      audioInputRef.current?.click();
      return;
    }
    ensureGraph();
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  }, [audioUrl, ensureGraph]);

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  };

  const skip = useCallback((seconds: number) => {
    if (!audioRef.current) return;
    seek(Math.max(0, Math.min(duration || Infinity, audioRef.current.currentTime + seconds)));
  }, [duration]);

  const toggleRecording = async () => {
    if (isRecording) {
      recorderRef.current?.stop();
      return;
    }
    const graph = ensureGraph();
    if (!graph) return;
    const ready = micReady || await enableMic();
    if (!ready) return;
    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(graph.recordDestination.stream, { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const url = URL.createObjectURL(blob);
      setRecordingUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return url;
      });
      setIsRecording(false);
      setToast("演唱已录好，可以试听或下载");
    };
    recorder.start(300);
    setIsRecording(true);
    if (audioUrl && audioRef.current?.paused) await togglePlay();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlay();
      }
      if (event.code === "ArrowLeft") skip(-5);
      if (event.code === "ArrowRight") skip(5);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [skip, togglePlay]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  return (
    <main className="app-shell">
      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onEnded={() => setIsPlaying(false)}
      />
      <input ref={audioInputRef} className="visually-hidden" type="file" accept="audio/*" onChange={handleAudioFile} />
      <input ref={lyricInputRef} className="visually-hidden" type="file" accept=".lrc,.txt,text/plain" onChange={handleLyricFile} />

      <header className="topbar">
        <button className="brand" type="button" onClick={() => audioInputRef.current?.click()} aria-label="选择伴奏">
          <span className="brand-mark">声</span>
          <span><strong>声场</strong><small>KARAOKE ROOM</small></span>
        </button>
        <div className="top-actions">
          <span className="privacy"><i />歌曲仅在本机处理</span>
          <button className="icon-button" type="button" onClick={toggleFullscreen} title="全屏">↗</button>
        </div>
      </header>

      <section className="stage">
        <div className="aurora aurora-one" />
        <div className="aurora aurora-two" />
        <div className="stage-grid" />
        <div className="song-heading">
          <span className={audioUrl ? "live-dot ready" : "live-dot"} />
          <div>
            <p>{audioUrl ? "NOW SINGING" : "READY WHEN YOU ARE"}</p>
            <h1>{songName}</h1>
          </div>
          {audioUrl && <button type="button" onClick={() => audioInputRef.current?.click()}>换一首</button>}
        </div>

        {!audioUrl ? (
          <div className="empty-stage">
            <div className="disc"><span>♫</span></div>
            <p>拖入或选择一个 MP3 / WAV 伴奏</p>
            <button className="primary-cta" type="button" onClick={() => audioInputRef.current?.click()}>
              <span>+</span> 选择本地伴奏
            </button>
            <small>提示：使用纯伴奏版，演唱效果最好</small>
          </div>
        ) : (
          <div className="lyrics-window" ref={lyricsStageRef}>
            <div className="lyrics-spacer" />
            {lyrics.map((line, index) => (
              <p
                key={`${line.time}-${index}`}
                ref={(node) => { lyricRefs.current[index] = node; }}
                className={index === activeIndex ? "active" : index < activeIndex ? "past" : ""}
                onClick={() => seek(line.time)}
              >
                {line.text}
              </p>
            ))}
            <div className="lyrics-spacer" />
          </div>
        )}

        <div className="stage-tools">
          <button type="button" onClick={() => lyricInputRef.current?.click()}>▤ 导入 LRC</button>
          <button type="button" onClick={() => setShowLyricsEditor(true)}>✎ 粘贴歌词</button>
          <span className="shortcut-hint">空格播放 · ← → 快退快进</span>
        </div>
      </section>

      <section className="console" aria-label="K歌控制台">
        <div className="timeline-row">
          <span>{formatTime(currentTime)}</span>
          <input
            aria-label="歌曲进度"
            className="timeline"
            type="range"
            min="0"
            max={duration || 100}
            step="0.01"
            value={currentTime}
            onChange={(event) => seek(Number(event.target.value))}
            style={{ "--progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
          />
          <span>{formatTime(duration)}</span>
        </div>

        <div className="console-grid">
          <div className="mixer-block">
            <div className="control-label"><span>♫</span><div><strong>伴奏</strong><small>MUSIC</small></div></div>
            <input aria-label="伴奏音量" type="range" min="0" max="100" value={musicVolume} onChange={(e) => setMusicVolume(Number(e.target.value))} />
            <output>{musicVolume}</output>
          </div>
          <div className="mixer-block">
            <div className="control-label"><span>◉</span><div><strong>麦克风</strong><small>MIC</small></div></div>
            <input aria-label="麦克风音量" type="range" min="0" max="100" value={micVolume} onChange={(e) => setMicVolume(Number(e.target.value))} />
            <output>{micVolume}</output>
            <div className="meter" aria-label="麦克风音量指示"><i style={{ width: `${meter}%` }} /></div>
          </div>
          <div className="transport">
            <button type="button" className="skip" onClick={() => skip(-5)} aria-label="快退5秒">−5</button>
            <button type="button" className="play" onClick={() => void togglePlay()} aria-label={isPlaying ? "暂停" : "播放"}>
              {isPlaying ? "Ⅱ" : "▶"}
            </button>
            <button type="button" className="skip" onClick={() => skip(5)} aria-label="快进5秒">+5</button>
          </div>
          <div className="effects-block">
            <label><span>回声</span><small>{echo}%</small></label>
            <input aria-label="回声强度" type="range" min="0" max="70" value={echo} onChange={(e) => setEcho(Number(e.target.value))} />
          </div>
          <button
            type="button"
            className={`monitor-button ${monitoring ? "on" : ""}`}
            onClick={async () => {
              const ready = micReady || await enableMic();
              if (ready) setMonitoring((value) => !value);
            }}
          >
            <span>◉</span><strong>{monitoring ? "耳返开" : "耳返关"}</strong><small>请戴耳机</small>
          </button>
          <button type="button" className={`record-button ${isRecording ? "recording" : ""}`} onClick={() => void toggleRecording()}>
            <span />{isRecording ? "停止录音" : "录下这首"}
          </button>
        </div>
      </section>

      {recordingUrl && (
        <aside className="recording-card">
          <div><span>✓</span><p><strong>你的演唱已录好</strong><small>下载前可以先试听</small></p></div>
          <audio src={recordingUrl} controls />
          <a href={recordingUrl} download={`${songName || "我的演唱"}-声场.webm`}>下载录音 ↓</a>
        </aside>
      )}

      {showLyricsEditor && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowLyricsEditor(false)}>
          <section className="lyrics-editor" role="dialog" aria-modal="true" aria-labelledby="lyrics-title" onMouseDown={(e) => e.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setShowLyricsEditor(false)}>×</button>
            <p className="eyebrow">LYRICS</p>
            <h2 id="lyrics-title">粘贴你的歌词</h2>
            <p>支持 LRC 时间标签。如果是普通文字，我们会自动把每行均匀排进歌曲里。</p>
            <textarea
              autoFocus
              value={lyricsDraft}
              onChange={(event) => setLyricsDraft(event.target.value)}
              placeholder={"[00:12.00] 第一句歌词\n[00:18.50] 第二句歌词\n\n或者直接一行一句粘贴也可以"}
            />
            <div className="modal-actions">
              <button type="button" onClick={() => lyricInputRef.current?.click()}>从文件导入</button>
              <button className="primary-cta" type="button" onClick={applyLyrics}>应用歌词</button>
            </div>
          </section>
        </div>
      )}

      {micError && <div className="error-toast">{micError}</div>}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
