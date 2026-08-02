"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FFmpeg as FFmpegType } from "@ffmpeg/ffmpeg";

type LyricLine = { time: number; text: string };
type DeviceOption = { deviceId: string; label: string };
type KtvSource = { file: File; accompanimentAudioIndex: number; audioChannels: number[] };
type AudioContextWithSink = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
type MediaElementWithSink = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
type MediaDevicesWithOutputPicker = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};
type AudioGraph = {
  context: AudioContext;
  musicGain: GainNode;
  accompanimentTrackGain: GainNode;
  originalTrackGain: GainNode;
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
  const originalAudioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const recordingPreviewRef = useRef<HTMLAudioElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const originalInputRef = useRef<HTMLInputElement>(null);
  const ktvVideoInputRef = useRef<HTMLInputElement>(null);
  const lyricInputRef = useRef<HTMLInputElement>(null);
  const lyricsStageRef = useRef<HTMLDivElement>(null);
  const lyricRefs = useRef<Array<HTMLParagraphElement | null>>([]);
  const graphRef = useRef<AudioGraph | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const animationRef = useRef<number | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const originalObjectUrlRef = useRef<string | null>(null);
  const videoObjectUrlRef = useRef<string | null>(null);
  const vocalReducedObjectUrlRef = useRef<string | null>(null);
  const ffmpegRef = useRef<FFmpegType | null>(null);
  const ktvSourceRef = useRef<KtvSource | null>(null);
  const conversionPhaseRef = useRef({ start: 0, span: 1 });

  const [songName, setSongName] = useState("还没有选择歌曲");
  const [audioUrl, setAudioUrl] = useState("");
  const [originalAudioUrl, setOriginalAudioUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [vocalReducedAudioUrl, setVocalReducedAudioUrl] = useState("");
  const [vocalReductionOn, setVocalReductionOn] = useState(false);
  const [conversionMode, setConversionMode] = useState<"video" | "vocal">("video");
  const [trackMode, setTrackMode] = useState<"original" | "accompaniment">("accompaniment");
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
  const [isConverting, setIsConverting] = useState(false);
  const [conversionProgress, setConversionProgress] = useState(0);
  const [conversionStatus, setConversionStatus] = useState("");
  const [conversionError, setConversionError] = useState("");
  const [ktvTrackNote, setKtvTrackNote] = useState("");

  const hasSong = Boolean(audioUrl || originalAudioUrl);
  const playbackAudioUrl = vocalReductionOn && vocalReducedAudioUrl ? vocalReducedAudioUrl : audioUrl;
  const effectiveTrackMode = trackMode === "original" && originalAudioUrl
    ? "original"
    : audioUrl
      ? "accompaniment"
      : "original";

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
    const originalAudio = originalAudioRef.current;
    if (!audio || !originalAudio) return null;
    const context = new AudioContext();
    const musicSource = context.createMediaElementSource(audio);
    const originalMusicSource = context.createMediaElementSource(originalAudio);
    const musicGain = context.createGain();
    const accompanimentTrackGain = context.createGain();
    const originalTrackGain = context.createGain();
    const micGain = context.createGain();
    const monitorGain = context.createGain();
    const wetGain = context.createGain();
    const delay = context.createDelay(1);
    const feedback = context.createGain();
    const analyser = context.createAnalyser();
    const recordDestination = context.createMediaStreamDestination();

    musicGain.gain.value = musicVolume / 100;
    accompanimentTrackGain.gain.value = effectiveTrackMode === "accompaniment" ? 1 : 0;
    originalTrackGain.gain.value = effectiveTrackMode === "original" ? 1 : 0;
    micGain.gain.value = micVolume / 100;
    monitorGain.gain.value = monitoring ? 1 : 0;
    wetGain.gain.value = echo / 100;
    delay.delayTime.value = 0.19;
    feedback.gain.value = 0.22;
    analyser.fftSize = 256;

    musicSource.connect(accompanimentTrackGain);
    originalMusicSource.connect(originalTrackGain);
    accompanimentTrackGain.connect(musicGain);
    originalTrackGain.connect(musicGain);
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

    graphRef.current = {
      context,
      musicGain,
      accompanimentTrackGain,
      originalTrackGain,
      micGain,
      monitorGain,
      wetGain,
      delay,
      analyser,
      recordDestination,
    };
    const sinkContext = context as AudioContextWithSink;
    if (selectedOutputId && sinkContext.setSinkId) {
      void sinkContext.setSinkId(selectedOutputId).catch(() => undefined);
    }
    return graphRef.current;
  }, [echo, effectiveTrackMode, micVolume, monitoring, musicVolume, selectedOutputId]);

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
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const now = graph.context.currentTime;
    graph.accompanimentTrackGain.gain.setTargetAtTime(effectiveTrackMode === "accompaniment" ? 1 : 0, now, 0.012);
    graph.originalTrackGain.gain.setTargetAtTime(effectiveTrackMode === "original" ? 1 : 0, now, 0.012);
  }, [effectiveTrackMode]);

  useEffect(() => () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    if (originalObjectUrlRef.current) URL.revokeObjectURL(originalObjectUrlRef.current);
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
    if (vocalReducedObjectUrlRef.current) URL.revokeObjectURL(vocalReducedObjectUrlRef.current);
    ffmpegRef.current?.terminate();
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

  const clearVocalReduction = () => {
    if (vocalReducedObjectUrlRef.current) URL.revokeObjectURL(vocalReducedObjectUrlRef.current);
    vocalReducedObjectUrlRef.current = null;
    setVocalReducedAudioUrl("");
    setVocalReductionOn(false);
  };

  const handleAudioFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    clearVocalReduction();
    ktvSourceRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setAudioUrl(url);
    setSongName(file.name.replace(/\.[^.]+$/, ""));
    setTrackMode("accompaniment");
    setCurrentTime(0);
    setIsPlaying(false);
    originalAudioRef.current?.pause();
    setRecordingUrl("");
    setToast("伴奏已加入，准备开唱");
    event.target.value = "";
  };

  const handleOriginalFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    clearVocalReduction();
    ktvSourceRef.current = null;
    if (originalObjectUrlRef.current) URL.revokeObjectURL(originalObjectUrlRef.current);
    const url = URL.createObjectURL(file);
    originalObjectUrlRef.current = url;
    setOriginalAudioUrl(url);
    if (!audioUrl) setSongName(file.name.replace(/\.[^.]+$/, ""));
    setTrackMode("original");
    audioRef.current?.pause();
    originalAudioRef.current?.pause();
    setCurrentTime(0);
    setIsPlaying(false);
    setRecordingUrl("");
    setToast("原唱已加入，可以一键切换");
    event.target.value = "";
  };

  const replaceMediaUrl = (kind: "accompaniment" | "original" | "video", blob: Blob) => {
    const url = URL.createObjectURL(blob);
    if (kind === "accompaniment") {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;
      setAudioUrl(url);
    } else if (kind === "original") {
      if (originalObjectUrlRef.current) URL.revokeObjectURL(originalObjectUrlRef.current);
      originalObjectUrlRef.current = url;
      setOriginalAudioUrl(url);
    } else {
      if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
      videoObjectUrlRef.current = url;
      setVideoUrl(url);
    }
  };

  const readWasmFileAsBlob = async (ffmpeg: FFmpegType, path: string, mimeType: string) => {
    const data = await ffmpeg.readFile(path);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    return new Blob([bytes.slice().buffer], { type: mimeType });
  };

  const loadConverter = async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    setConversionStatus("首次使用，正在加载本地转换引擎…");
    setConversionProgress(3);
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import("@ffmpeg/ffmpeg"),
      import("@ffmpeg/util"),
    ]);
    const ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress }) => {
      const phase = conversionPhaseRef.current;
      const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      setConversionProgress(Math.round(phase.start + safeProgress * phase.span));
    });
    const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegRef.current = ffmpeg;
    setConversionProgress(15);
    return ffmpeg;
  };

  const handleKtvVideoFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024 * 1024) {
      setMicError("网页版暂时只处理 1 GB 以内的 KTV 文件。");
      return;
    }

    clearVocalReduction();
    ktvSourceRef.current = null;
    setConversionMode("video");
    setIsConverting(true);
    setConversionError("");
    setConversionProgress(1);
    setConversionStatus("正在准备转换…");
    audioRef.current?.pause();
    originalAudioRef.current?.pause();
    videoRef.current?.pause();
    setIsPlaying(false);

    let mounted = false;
    try {
      const ffmpeg = await loadConverter();
      const { FFFSType } = await import("@ffmpeg/ffmpeg");
      const mountPoint = "/ktv-input";
      try { await ffmpeg.createDir(mountPoint); } catch { /* already exists */ }
      await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountPoint);
      mounted = true;
      const inputPath = `${mountPoint}/${file.name}`;

      setConversionStatus("正在识别画面、音轨和声道…");
      setConversionProgress(17);
      await ffmpeg.ffprobe([
        "-v", "error",
        "-show_entries", "stream=index,codec_type,channels:stream_tags=title,language",
        "-of", "json",
        inputPath,
        "-o", "probe.json",
      ]);
      const probeData = await ffmpeg.readFile("probe.json", "utf8");
      const probe = JSON.parse(typeof probeData === "string" ? probeData : new TextDecoder().decode(probeData)) as {
        streams?: Array<{ codec_type?: string; channels?: number; tags?: { title?: string; language?: string } }>;
      };
      const audioStreams = (probe.streams || []).filter((stream) => stream.codec_type === "audio");
      if (!audioStreams.length) throw new Error("这个文件里没有找到音频轨道。");

      setConversionStatus("正在把 MV 画面转成浏览器格式…");
      conversionPhaseRef.current = { start: 20, span: 52 };
      const videoExitCode = await ffmpeg.exec([
        "-i", inputPath,
        "-map", "0:v:0",
        "-an",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "29",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "ktv-mv.mp4",
      ]);
      if (videoExitCode !== 0) throw new Error("画面转换失败，可能是这个文件使用了特殊视频编码。");

      setConversionStatus("正在提取原唱和伴奏…");
      let firstTitle = (audioStreams[0]?.tags?.title || "").toLowerCase();
      let secondTitle = (audioStreams[1]?.tags?.title || "").toLowerCase();
      const isAccompanimentTitle = (title: string) => /(伴奏|karaoke|instrumental|accomp|music)/i.test(title);
      const accompanimentAudioIndex = audioStreams.length >= 2 && isAccompanimentTitle(firstTitle) && !isAccompanimentTitle(secondTitle) ? 0 : Math.min(1, audioStreams.length - 1);

      if (audioStreams.length >= 2) {
        conversionPhaseRef.current = { start: 74, span: 9 };
        await ffmpeg.exec(["-i", inputPath, "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "3", "track-one.mp3"]);
        conversionPhaseRef.current = { start: 83, span: 9 };
        await ffmpeg.exec(["-i", inputPath, "-map", "0:a:1", "-vn", "-c:a", "libmp3lame", "-q:a", "3", "track-two.mp3"]);
      } else if ((audioStreams[0]?.channels || 0) >= 2) {
        conversionPhaseRef.current = { start: 74, span: 9 };
        await ffmpeg.exec(["-i", inputPath, "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-c:a", "libmp3lame", "-q:a", "3", "track-one.mp3"]);
        conversionPhaseRef.current = { start: 83, span: 9 };
        await ffmpeg.exec(["-i", inputPath, "-map", "0:a:0", "-af", "pan=mono|c0=c1", "-c:a", "libmp3lame", "-q:a", "3", "track-two.mp3"]);
        firstTitle = "left";
        secondTitle = "right";
      } else {
        conversionPhaseRef.current = { start: 76, span: 16 };
        await ffmpeg.exec(["-i", inputPath, "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "3", "track-one.mp3"]);
      }

      setConversionStatus("正在装入 K 歌舞台…");
      setConversionProgress(94);
      const videoBlob = await readWasmFileAsBlob(ffmpeg, "ktv-mv.mp4", "video/mp4");
      const firstTrackBlob = await readWasmFileAsBlob(ffmpeg, "track-one.mp3", "audio/mpeg");
      replaceMediaUrl("video", videoBlob);

      if (audioStreams.length >= 2 || (audioStreams[0]?.channels || 0) >= 2) {
        const secondTrackBlob = await readWasmFileAsBlob(ffmpeg, "track-two.mp3", "audio/mpeg");
        if (isAccompanimentTitle(firstTitle) && !isAccompanimentTitle(secondTitle)) {
          replaceMediaUrl("accompaniment", firstTrackBlob);
          replaceMediaUrl("original", secondTrackBlob);
        } else {
          replaceMediaUrl("original", firstTrackBlob);
          replaceMediaUrl("accompaniment", secondTrackBlob);
        }
        setTrackMode("accompaniment");
        setKtvTrackNote("已识别两路声音。如果原唱、伴奏反了，点击“对调音轨”。");
      } else {
        replaceMediaUrl("accompaniment", firstTrackBlob);
        if (originalObjectUrlRef.current) URL.revokeObjectURL(originalObjectUrlRef.current);
        originalObjectUrlRef.current = null;
        setOriginalAudioUrl("");
        setTrackMode("accompaniment");
        setKtvTrackNote("只找到一路单声道音频，已作为伴奏载入。");
      }

      ktvSourceRef.current = {
        file,
        accompanimentAudioIndex,
        audioChannels: audioStreams.map((stream) => stream.channels || 0),
      };

      setSongName(file.name.replace(/\.[^.]+$/, ""));
      setCurrentTime(0);
      setDuration(0);
      setRecordingUrl("");
      setConversionProgress(100);
      setConversionStatus("转换完成，准备开唱");
      setToast("KTV 视频已载入");
      window.setTimeout(() => setIsConverting(false), 700);

      for (const path of ["probe.json", "ktv-mv.mp4", "track-one.mp3", "track-two.mp3"]) {
        try { await ffmpeg.deleteFile(path); } catch { /* optional output */ }
      }
    } catch (error) {
      setConversionError(error instanceof Error ? error.message : "转换失败，请换一个文件重试。");
      setConversionStatus("没有完成转换");
    } finally {
      if (mounted && ffmpegRef.current) {
        try { await ffmpegRef.current.unmount("/ktv-input"); } catch { /* already unmounted */ }
      }
    }
  };

  const cancelConversion = () => {
    ffmpegRef.current?.terminate();
    ffmpegRef.current = null;
    setIsConverting(false);
    setConversionError("");
    setConversionStatus("");
    setConversionProgress(0);
  };

  const toggleVocalReduction = async () => {
    audioRef.current?.pause();
    originalAudioRef.current?.pause();
    videoRef.current?.pause();
    setIsPlaying(false);

    if (vocalReducedAudioUrl) {
      setVocalReductionOn((enabled) => !enabled);
      setTrackMode("accompaniment");
      setToast(vocalReductionOn ? "已恢复普通伴奏" : "已启用人声削弱伴奏");
      return;
    }

    const source = ktvSourceRef.current;
    if (!source) {
      setMicError("请先导入一个 MKV 或 MPG 的 KTV 视频。");
      return;
    }
    if ((source.audioChannels[source.accompanimentAudioIndex] || 0) < 2) {
      setMicError("当前伴奏音轨是单声道，无法用左右声道抵消人声。请先试试“对调音轨”。");
      return;
    }

    setConversionMode("vocal");
    setIsConverting(true);
    setConversionError("");
    setConversionProgress(2);
    setConversionStatus("正在分析左右声道中的人声位置…");
    let mounted = false;
    try {
      const ffmpeg = await loadConverter();
      const { FFFSType } = await import("@ffmpeg/ffmpeg");
      const mountPoint = "/vocal-input";
      try { await ffmpeg.createDir(mountPoint); } catch { /* already exists */ }
      await ffmpeg.mount(FFFSType.WORKERFS, { files: [source.file] }, mountPoint);
      mounted = true;
      const inputPath = `${mountPoint}/${source.file.name}`;

      setConversionStatus("正在削弱位于中央的人声…");
      conversionPhaseRef.current = { start: 12, span: 82 };
      const exitCode = await ffmpeg.exec([
        "-i", inputPath,
        "-map", `0:a:${source.accompanimentAudioIndex}`,
        "-vn",
        "-af", "pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0,highpass=f=80,lowpass=f=15000,volume=2",
        "-c:a", "libmp3lame",
        "-q:a", "2",
        "vocal-reduced.mp3",
      ]);
      if (exitCode !== 0) throw new Error("这个文件的人声削弱处理没有成功。");

      setConversionStatus("正在装入新伴奏…");
      setConversionProgress(96);
      const blob = await readWasmFileAsBlob(ffmpeg, "vocal-reduced.mp3", "audio/mpeg");
      if (vocalReducedObjectUrlRef.current) URL.revokeObjectURL(vocalReducedObjectUrlRef.current);
      const url = URL.createObjectURL(blob);
      vocalReducedObjectUrlRef.current = url;
      setVocalReducedAudioUrl(url);
      setVocalReductionOn(true);
      setTrackMode("accompaniment");
      setConversionProgress(100);
      setConversionStatus("处理完成，可以试听了");
      setKtvTrackNote("已启用人声削弱。它适合人声居中的立体声，少量和声或混响可能仍会保留。");
      setToast("人声削弱伴奏已启用");
      window.setTimeout(() => setIsConverting(false), 650);
      try { await ffmpeg.deleteFile("vocal-reduced.mp3"); } catch { /* optional output */ }
    } catch (error) {
      setConversionError(error instanceof Error ? error.message : "人声削弱失败，请换一首歌重试。");
      setConversionStatus("没有完成人声削弱");
    } finally {
      if (mounted && ffmpegRef.current) {
        try { await ffmpegRef.current.unmount("/vocal-input"); } catch { /* already unmounted */ }
      }
    }
  };

  const swapKtvTracks = () => {
    if (!audioUrl || !originalAudioUrl) return;
    const currentAccompaniment = audioUrl;
    const currentOriginal = originalAudioUrl;
    const currentAccompanimentObjectUrl = objectUrlRef.current;
    clearVocalReduction();
    const source = ktvSourceRef.current;
    if (source && source.audioChannels.length >= 2) {
      source.accompanimentAudioIndex = source.accompanimentAudioIndex === 0 ? 1 : 0;
    }
    objectUrlRef.current = originalObjectUrlRef.current;
    originalObjectUrlRef.current = currentAccompanimentObjectUrl;
    setAudioUrl(currentOriginal);
    setOriginalAudioUrl(currentAccompaniment);
    setTrackMode((mode) => mode === "original" ? "accompaniment" : "original");
    setToast("原唱和伴奏已对调");
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
    const accompaniment = audioRef.current;
    const original = originalAudioRef.current;
    const primary = effectiveTrackMode === "original" ? original : accompaniment;
    if (!hasSong || !primary) {
      audioInputRef.current?.click();
      return;
    }
    ensureGraph();
    if (primary.paused) {
      const secondary = effectiveTrackMode === "original" ? accompaniment : original;
      if (secondary && ((effectiveTrackMode === "original" && audioUrl) || (effectiveTrackMode === "accompaniment" && originalAudioUrl))) {
        secondary.currentTime = primary.currentTime;
      }
      const plays: Promise<void>[] = [primary.play()];
      if (secondary && ((effectiveTrackMode === "original" && audioUrl) || (effectiveTrackMode === "accompaniment" && originalAudioUrl))) {
        plays.push(secondary.play());
      }
      if (videoRef.current && videoUrl) {
        videoRef.current.currentTime = primary.currentTime;
        plays.push(videoRef.current.play());
      }
      await Promise.all(plays);
      setIsPlaying(true);
    } else {
      accompaniment?.pause();
      original?.pause();
      videoRef.current?.pause();
      setIsPlaying(false);
    }
  }, [audioUrl, effectiveTrackMode, ensureGraph, hasSong, originalAudioUrl, videoUrl]);

  const seek = (value: number) => {
    if (audioRef.current && audioUrl) audioRef.current.currentTime = value;
    if (originalAudioRef.current && originalAudioUrl) originalAudioRef.current.currentTime = value;
    if (videoRef.current && videoUrl) videoRef.current.currentTime = value;
    setCurrentTime(value);
  };

  const skip = useCallback((seconds: number) => {
    seek(Math.max(0, Math.min(duration || Infinity, currentTime + seconds)));
  }, [currentTime, duration]);

  const selectTrackMode = (mode: "original" | "accompaniment") => {
    if (mode === "original" && !originalAudioUrl) {
      originalInputRef.current?.click();
      return;
    }
    if (mode === "accompaniment" && !audioUrl) {
      audioInputRef.current?.click();
      return;
    }
    setTrackMode(mode);
    const target = mode === "original" ? originalAudioRef.current : audioRef.current;
    if (target) setDuration(target.duration || duration);
    setToast(mode === "original" ? "已切换到原唱" : "已切换到伴奏");
  };

  const handleTrackTimeUpdate = (mode: "original" | "accompaniment", element: HTMLAudioElement) => {
    if (mode !== effectiveTrackMode) return;
    setCurrentTime(element.currentTime);
    const other = mode === "original" ? audioRef.current : originalAudioRef.current;
    const otherExists = mode === "original" ? audioUrl : originalAudioUrl;
    if (other && otherExists && Math.abs(other.currentTime - element.currentTime) > 0.18) {
      other.currentTime = element.currentTime;
    }
    if (videoRef.current && videoUrl && Math.abs(videoRef.current.currentTime - element.currentTime) > 0.18) {
      videoRef.current.currentTime = element.currentTime;
    }
  };

  const handleTrackEnded = (mode: "original" | "accompaniment") => {
    if (mode !== effectiveTrackMode) return;
    audioRef.current?.pause();
    originalAudioRef.current?.pause();
    videoRef.current?.pause();
    setIsPlaying(false);
  };

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
    if (hasSong && !isPlaying) await togglePlay();
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
        src={playbackAudioUrl || undefined}
        onTimeUpdate={(event) => handleTrackTimeUpdate("accompaniment", event.currentTarget)}
        onLoadedMetadata={(event) => {
          if (effectiveTrackMode === "accompaniment") setDuration(event.currentTarget.duration);
          if (currentTime) event.currentTarget.currentTime = currentTime;
        }}
        onEnded={() => handleTrackEnded("accompaniment")}
      />
      <audio
        ref={originalAudioRef}
        src={originalAudioUrl || undefined}
        onTimeUpdate={(event) => handleTrackTimeUpdate("original", event.currentTarget)}
        onLoadedMetadata={(event) => {
          if (effectiveTrackMode === "original") setDuration(event.currentTarget.duration);
          if (currentTime) event.currentTarget.currentTime = currentTime;
        }}
        onEnded={() => handleTrackEnded("original")}
      />
      <input ref={audioInputRef} className="visually-hidden" type="file" accept="audio/*" onChange={handleAudioFile} />
      <input ref={originalInputRef} className="visually-hidden" type="file" accept="audio/*" onChange={handleOriginalFile} />
      <input
        ref={ktvVideoInputRef}
        className="visually-hidden"
        type="file"
        accept=".mkv,.mpg,.mpeg,video/x-matroska,video/mpeg"
        onChange={(event) => void handleKtvVideoFile(event)}
      />
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
          <span className={hasSong ? "live-dot ready" : "live-dot"} />
          <div>
            <p>{hasSong ? "NOW SINGING" : "READY WHEN YOU ARE"}</p>
            <h1>{songName}</h1>
          </div>
          {hasSong && (
            <div className="track-switch" aria-label="原唱伴奏切换">
              <button className={effectiveTrackMode === "original" ? "active" : ""} type="button" onClick={() => selectTrackMode("original")}>
                {originalAudioUrl ? "原唱" : "+ 原唱"}
              </button>
              <button className={effectiveTrackMode === "accompaniment" ? "active" : ""} type="button" onClick={() => selectTrackMode("accompaniment")}>
                {audioUrl ? "伴奏" : "+ 伴奏"}
              </button>
            </div>
          )}
        </div>

        {!hasSong ? (
          <div className="empty-stage">
            <div className="disc"><span>♫</span></div>
            <p>直接打开 KTV 视频，或分别加入原唱和伴奏</p>
            <div className="empty-actions">
              <button className="ktv-import-cta" type="button" onClick={() => ktvVideoInputRef.current?.click()}><span>▣</span> 打开 MKV / MPG</button>
              <button className="primary-cta" type="button" onClick={() => audioInputRef.current?.click()}><span>+</span> 选择伴奏</button>
              <button className="secondary-cta" type="button" onClick={() => originalInputRef.current?.click()}><span>+</span> 添加原唱</button>
            </div>
            <small>KTV 文件会在浏览器本机转换，首次需要加载约 31 MB 引擎</small>
          </div>
        ) : videoUrl ? (
          <div className="mv-stage">
            <video ref={videoRef} className="mv-video" src={videoUrl} muted playsInline />
            <div className="mv-vignette" />
            {ktvTrackNote && <p className="track-note">{ktvTrackNote}</p>}
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
          <button type="button" onClick={() => ktvVideoInputRef.current?.click()}>▣ 导入 KTV 视频</button>
          <button type="button" onClick={() => lyricInputRef.current?.click()}>▤ 导入 LRC</button>
          <button type="button" onClick={() => setShowLyricsEditor(true)}>✎ 粘贴歌词</button>
          {videoUrl && originalAudioUrl && audioUrl && <button type="button" onClick={swapKtvTracks}>⇄ 对调音轨</button>}
          {videoUrl && audioUrl && (
            <button className={vocalReductionOn ? "vocal-reduction active" : "vocal-reduction"} type="button" onClick={() => void toggleVocalReduction()}>
              ✦ {vocalReductionOn ? "恢复普通伴奏" : "人声削弱（实验）"}
            </button>
          )}
          {hasSong && <button type="button" onClick={() => originalInputRef.current?.click()}>↻ 更换原唱</button>}
          {hasSong && <button type="button" onClick={() => audioInputRef.current?.click()}>↻ 更换伴奏</button>}
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

      {isConverting && (
        <div className="converter-backdrop">
          <section className="converter-card" role="dialog" aria-modal="true" aria-labelledby="converter-title">
            <div className="converter-orbit" aria-hidden="true"><span>♫</span></div>
            <p className="eyebrow">{conversionMode === "vocal" ? "VOCAL REDUCTION" : "LOCAL VIDEO CONVERTER"}</p>
            <h2 id="converter-title">{conversionMode === "vocal" ? "正在制作人声削弱伴奏" : "正在准备你的 KTV 视频"}</h2>
            <p className="converter-status">{conversionStatus}</p>
            <div className="converter-progress" aria-label={`转换进度 ${conversionProgress}%`}>
              <i style={{ width: `${conversionProgress}%` }} />
            </div>
            <strong>{conversionProgress}%</strong>
            <small>
              {conversionMode === "vocal"
                ? "利用左右声道差异削弱居中的主唱；和声、混响或偏离中央的人声可能仍会保留。"
                : "整个过程只在你的电脑上进行。大文件可能需要几分钟，请保持页面打开。"}
            </small>
            {conversionError && <p className="converter-error">{conversionError}</p>}
            <button type="button" onClick={cancelConversion}>{conversionError ? "关闭" : "取消转换"}</button>
          </section>
        </div>
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
