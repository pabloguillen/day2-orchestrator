import { ffmpeg } from "./engine";

/**
 * Sound for a rendered composition: short cues on the cuts (whoosh), taps
 * (click) and reveals (pop), on top of a music bed — the app's music from
 * ElevenLabs or an owner-uploaded track when there is one, else day2's quiet
 * built-in beat. Everything is synthesised by ffmpeg (no stock audio, no
 * licences), then muxed into the social spec (H.264 High / AAC 48 kHz stereo,
 * 30 fps, 2 s GOPs, moov first).
 */

export type Cue = { t: number; kind: "whoosh" | "tap" | "pop" };
export type AudioPlan = { seconds: number; cues: Cue[]; music?: string | null; /** Built-in beat when there's no music (default true). */ beat?: boolean; bpm?: number };

const CUE_SRC: Record<Cue["kind"], (i: number) => string> = {
  // Pink noise through a band-pass, faded in and out: an airy swish.
  whoosh: (i) => `anoisesrc=d=0.42:c=pink:a=0.6:seed=${7 + i},bandpass=f=1400:width_type=o:w=2.2,afade=t=in:d=0.22,afade=t=out:st=0.22:d=0.2,volume=0.55`,
  // A short high click with a fast decay.
  tap: () => `aevalsrc='0.55*sin(2*PI*1900*t)*exp(-90*t)':d=0.07:s=48000`,
  // A rising blip with a soft decay.
  pop: () => `aevalsrc='0.5*sin(2*PI*(420+1600*t)*t)*exp(-22*t)':d=0.22:s=48000`,
};

/** A minimal, quiet beat (kick on every beat, a shaker on the off-beats) for `seconds`. Pure: the lavfi source. */
export function beatSource(seconds: number, bpm = 104): string {
  const b = 60 / bpm;
  const kick = `0.9*sin(2*PI*(52+90*exp(-28*mod(t,${b.toFixed(4)})))*mod(t,${b.toFixed(4)}))*exp(-9*mod(t,${b.toFixed(4)}))`;
  const shaker = `0.12*(random(0)*2-1)*exp(-60*mod(t+${(b / 2).toFixed(4)},${b.toFixed(4)}))`;
  return `aevalsrc='(${kick})+(${shaker})':d=${seconds.toFixed(2)}:s=48000`;
}

/** The ffmpeg arguments that add the plan's sound to a silent video and encode for Reels/TikTok. Pure. */
export function mixArgs(video: string, plan: AudioPlan, out: string): string[] {
  const inputs: string[] = ["-i", video];
  const filters: string[] = [];
  const mixIn: string[] = [];
  let n = 1;
  const S = plan.seconds.toFixed(2);
  if (plan.music) {
    inputs.push("-stream_loop", "-1", "-i", plan.music);
    filters.push(`[${n}:a]atrim=0:${S},asetpts=N/SR/TB,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.32,afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, plan.seconds - 1.2).toFixed(2)}:d=1.2[m]`);
    mixIn.push("[m]");
    n++;
  } else if (plan.beat !== false) {
    inputs.push("-f", "lavfi", "-i", beatSource(plan.seconds, plan.bpm));
    filters.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,lowpass=f=5200,volume=0.16,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, plan.seconds - 1).toFixed(2)}:d=1[m]`);
    mixIn.push("[m]");
    n++;
  }
  plan.cues
    .filter((c) => c.t >= 0 && c.t < plan.seconds)
    .slice(0, 40)
    .forEach((c, i) => {
      inputs.push("-f", "lavfi", "-i", CUE_SRC[c.kind](i));
      const ms = Math.max(0, Math.round((c.kind === "whoosh" ? c.t - 0.18 : c.t) * 1000));
      filters.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms}[c${i}]`);
      mixIn.push(`[c${i}]`);
      n++;
    });
  // Always a track (some platforms refuse video without audio).
  inputs.push("-f", "lavfi", "-t", S, "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  mixIn.push(`[${n}:a]`);
  filters.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,atrim=0:${S},alimiter=limit=0.9[a]`);
  return [
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "0:v:0", "-map", "[a]",
    "-t", S,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "30", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    out,
  ];
}

export async function addSound(video: string, plan: AudioPlan, out: string): Promise<string> {
  await ffmpeg(mixArgs(video, plan, out));
  return out;
}
