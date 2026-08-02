"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type LyricLine = { time: number; text: string };
type DeviceOption = { deviceId: string; label: string };
type AudioContextWithSink = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
type MediaElementWithSink = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
type MediaDevicesWithOutputPicker = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};
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
  const recordingPreviewRef = useRef<HTMLAudioElement>(null);
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
  const [showDevicePanel, setShowDevicePanel] = useState(false);
  const [inputDevices, setInputDevices] = useState<DeviceOption[]>([]);
  const [outputDevices, setOutputDevices] = useState<DeviceOption[]>([]);
  const [selectedInputId, setSelectedInputId] = useState("default");
  const [selectedOutputId, setSelectedOutputId] = useState("default");
  const [outputSelectionSupported, setOutputSelectionSupported] = useState(true);
  const [devicesLoading, setDevicesLoading] = useState(false);

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

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setDevicesLoading(true);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      let micNumber = 0;
      let speakerNumber = 0;
      setInputDevices(devices.filter((device) => device.kind === "audioinput").map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `麦克风 ${++micNumber}`,
      })));
      setOutputDevices(devices.filter((device) => device.kind === "audiooutput").map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `音频输出 ${++speakerNumber}`,
      })));
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    const savedInput = window.localStorage.getItem("shengchang-input-device");
    const savedOutput = window.localStorage.getItem("shengchang-output-device");
    if (savedInput) setSelectedInputId(savedInput);
    if (savedOutput) setSelectedOutputId(savedOutput);
    const AudioContextConstructor = window.AudioContext;
    setOutputSelectionSupported(typeof (AudioContextConstructor?.prototype as AudioContextWithSink | undefined)?.setSinkId === "function");
    void refreshDevices();
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
  }, [refreshDevices]);

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
    const sinkContext = context as AudioContextWithSink;
    if (selectedOutputId && sinkContext.setSinkId) {
      void sinkContext.setSinkId(selectedOutputId).catch(() => undefined);
    }
    return graphRef.current;
  }, [echo, micVolume, monitoring, musicVolume, selectedOutputId]);

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
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    const values = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      analyser.getByteFrequencyData(values);
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      setMeter(Math.min(100, average * 1.35));
      animationRef.current = requestAnimationFrame(draw);
    };
    draw();
  }, []);

  const activateInput = useCallback(async (deviceId: string, announce = true) => {
    setMicError("");
    try {
      const graph = ensureGraph();
      if (!graph) return false;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId && deviceId !== "default" ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      graph.micSource?.disconnect();
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = stream;
      graph.micSource = graph.context.createMediaStreamSource(stream);
      graph.micSource.connect(graph.micGain);
      startMeter(graph.analyser);
      const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId || deviceId || "default";
      setSelectedInputId(activeDeviceId);
      window.localStorage.setItem("shengchang-input-device", activeDeviceId);
      setMicReady(true);
      await refreshDevices();
      if (announce) setToast("麦克风已切换");
      return true;
    } catch {
      setMicError("无法使用这个麦克风，请检查设备和浏览器权限。");
      return false;
    }
  }, [ensureGraph, refreshDevices, startMeter]);

  const enableMic = useCallback(async () => {
    if (micStreamRef.current) return true;
    const ready = await activateInput(selectedInputId, false);
    if (ready) setToast("麦克风已就位");
    return ready;
  }, [activateInput, selectedInputId]);

  const activateOutput = useCallback(async (requestedDeviceId: string) => {
    setMicError("");
    try {
      const graph = ensureGraph();
      if (!graph) return;
      const sinkContext = graph.context as AudioContextWithSink;
      if (!sinkContext.setSinkId) {
        setOutputSelectionSupported(false);
        setMicError("当前浏览器不支持网页内切换输出设备，请使用电脑的声音设置。");
        return;
      }
      let deviceId = requestedDeviceId;
      try {
        await sinkContext.setSinkId(deviceId);
      } catch {
        const mediaDevices = navigator.mediaDevices as MediaDevicesWithOutputPicker;
        if (!mediaDevices.selectAudioOutput) throw new Error("output-not-allowed");
        const selected = await mediaDevices.selectAudioOutput(deviceId && deviceId !== "default" ? { deviceId } : undefined);
        deviceId = selected.deviceId;
        await sinkContext.setSinkId(deviceId);
      }
      const preview = recordingPreviewRef.current as MediaElementWithSink | null;
      if (preview?.setSinkId) await preview.setSinkId(deviceId);
      setSelectedOutputId(deviceId);
      window.localStorage.setItem("shengchang-output-device", deviceId);
      await refreshDevices();
      setToast("输出设备已切换");
    } catch {
      setMicError("无法切换到这个输出设备，请允许声音设备权限或使用系统声音设置。");
    }
  }, [ensureGraph, refreshDevices]);

  useEffect(() => {
    const preview = recordingPreviewRef.current as MediaElementWithSink | null;
    if (recordingUrl && preview?.setSinkId && selectedOutputId) {
      void preview.setSinkId(selectedOutputId).catch(() => undefined);
    }
  }, [recordingUrl, selectedOutputId]);

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
          <button
            className={`device-trigger ${micReady ? "ready" : ""}`}
            type="button"
            onClick={() => {
              setShowDevicePanel(true);
              void refreshDevices();
            }}
          >
            <span>◉</span>声音设备
          </button>
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
          <audio ref={recordingPreviewRef} src={recordingUrl} controls />
          <a href={recordingUrl} download={`${songName || "我的演唱"}-声场.webm`}>下载录音 ↓</a>
        </aside>
      )}

      {showDevicePanel && (
        <div className="device-backdrop" role="presentation" onMouseDown={() => setShowDevicePanel(false)}>
          <section className="device-panel" role="dialog" aria-modal="true" aria-labelledby="device-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setShowDevicePanel(false)}>×</button>
            <p className="eyebrow">AUDIO ROUTING</p>
            <h2 id="device-title">声音设备</h2>
            <p className="device-intro">选择唱歌用的麦克风和耳机。开启耳返前请戴好耳机，避免啸叫。</p>

            <label className="device-field">
              <span><i className="input-device-icon">◉</i><b>输入设备</b><small>麦克风</small></span>
              <select
                aria-label="选择麦克风输入设备"
                value={inputDevices.some((device) => device.deviceId === selectedInputId) ? selectedInputId : "default"}
                onChange={(event) => void activateInput(event.target.value)}
              >
                <option value="default">系统默认麦克风</option>
                {inputDevices.filter((device) => device.deviceId !== "default").map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                ))}
              </select>
            </label>

            <label className="device-field">
              <span><i className="output-device-icon">◖</i><b>输出设备</b><small>耳机 / 音箱</small></span>
              <select
                aria-label="选择声音输出设备"
                value={outputDevices.some((device) => device.deviceId === selectedOutputId) ? selectedOutputId : "default"}
                disabled={!outputSelectionSupported}
                onChange={(event) => void activateOutput(event.target.value)}
              >
                <option value="default">系统默认输出</option>
                {outputDevices.filter((device) => device.deviceId !== "default").map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                ))}
              </select>
            </label>

            {!outputSelectionSupported && <p className="support-note">你的浏览器暂不支持网页内切换输出；麦克风仍可选择。建议使用 Chrome，或在电脑声音设置中切换耳机。</p>}

            <div className="device-actions">
              <button type="button" onClick={() => void refreshDevices()}>{devicesLoading ? "正在检查…" : "刷新设备"}</button>
              <button className="primary-cta" type="button" onClick={() => void enableMic()}>{micReady ? "麦克风已就位" : "允许并检测麦克风"}</button>
            </div>
          </section>
        </div>
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
