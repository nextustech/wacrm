/**
 * Record-and-transcribe button.
 *
 * One button, three states: idle → recording → transcribing. The audio goes to
 * the workspace's AI provider, which writes back whatever language was spoken,
 * so nothing has to be configured and the browser's own speech engine (which
 * cannot detect a language, and is missing entirely in embedded webviews) is
 * not involved.
 *
 * Shared by the composer and the AI reply assistant's custom instruction.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { webmOpusToOgg } from "@/lib/media/webm-opus-to-ogg";
import { transcribeSpeech } from "@/lib/ai/transcribe.functions";

/** Base64 body of a blob, without the data: prefix the API does not want. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked: spreading a megabyte-sized array into String.fromCharCode
  // overflows the call stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function DictationButton({
  onText,
  disabled,
  size = "iconSM",
  variant = "ghost",
  className,
  maxMs = 120_000,
  title = "Dictate — speak in any language and it is typed for you",
}: {
  /** Called with the transcript. Append or replace is the caller's choice. */
  onText: (text: string) => void;
  disabled?: boolean;
  size?: "icon" | "iconSM";
  variant?: "ghost" | "outline" | "secondary";
  className?: string;
  maxMs?: number;
  title?: string;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Never leave the microphone live when the UI around it goes away.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* already gone */
        }
      }
    },
    [],
  );

  const toggle = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("This browser cannot record audio");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error("Microphone access denied", {
        description: "Allow microphone access for this site, then try again.",
      });
      return;
    }

    try {
      const preferred = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"].find((m) =>
        MediaRecorder.isTypeSupported?.(m),
      );
      const rec = preferred
        ? new MediaRecorder(stream, { mimeType: preferred })
        : new MediaRecorder(stream);
      const recMime = (rec.mimeType || preferred || "audio/webm").split(";")[0]!;
      const chunks: Blob[] = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        if (timerRef.current) clearTimeout(timerRef.current);
        setRecording(false);

        let blob = new Blob(chunks, { type: recMime });
        if (blob.size === 0) {
          toast.error("Nothing was recorded");
          return;
        }
        // The transcriber does not accept WebM and Chromium records nothing
        // else, so rewrap it as Ogg — same container, same Opus audio.
        let mime = recMime;
        if (mime.includes("webm")) {
          const remuxed = webmOpusToOgg(new Uint8Array(await blob.arrayBuffer()));
          if (!remuxed) {
            toast.error("Could not prepare the recording for transcription");
            return;
          }
          blob = remuxed.blob;
          mime = "audio/ogg";
        }

        setBusy(true);
        try {
          const { text } = await transcribeSpeech({
            data: { audioBase64: await blobToBase64(blob), mimeType: mime },
          });
          if (!text) {
            toast.info("No speech was recognised in that recording");
            return;
          }
          onText(text);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Transcription failed");
        } finally {
          setBusy(false);
        }
      };

      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      timerRef.current = setTimeout(() => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      }, maxMs);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      toast.error("Could not start dictation");
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(
        "shrink-0",
        variant === "ghost" && "rounded-full",
        recording && "bg-destructive/10 text-destructive hover:text-destructive",
        className,
      )}
      disabled={disabled || busy}
      onClick={() => void toggle()}
      aria-label={recording ? "Stop and transcribe" : "Dictate"}
      aria-pressed={recording}
      title={busy ? "Transcribing…" : recording ? "Stop and transcribe" : title}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : recording ? (
        <Square className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </Button>
  );
}
