<div align="center">

<img src="./assets/logo.jpg" alt="Recut logo" width="112" />

# Audio Studio

**Turn audio and video into subtitles and transcripts locally, then narrate with authorized voice characters**

Recut's local voice workspace — transcription, voice characters and dubbing in one workflow

[中文](./README.md) · **English**

</div>

![Recut Audio Studio](./assets/audio-studio.jpg)

## What It Is

Audio Studio is Recut's **standalone voice App** (`standalone`). It treats voice as a first-class resource: transcribe into timestamped transcripts and subtitles, save reusable voice characters, and synthesize new lines from text.

- **Transcribe locally first**: Whisper or Qwen3-ASR runs on your machine — raw audio and video are not sent to the cloud by default.
- **Private until you confirm**: transcripts, characters and syntheses stay in the App's private sandbox until you explicitly save them as library Assets.
- **Same source as the Editor**: saved transcript Assets can be turned into caption tracks and editable scripts in the Video Editor.

> Install from **Apps** via [recut-audio-studio](https://github.com/6174/recut-audio-studio). First use auto-prepares Python 3.11, FFmpeg and models (see `runtime.python` in the manifest).

## Why Use It

### Local transcription with trustworthy timestamps

Whisper (Small / Medium / Large-v3) and Qwen3-ASR (0.6B / 1.7B with Qwen3-ForcedAligner) produce `transcript.json` and timestamped SRT. Every synthesis must pass an ASR round-trip check (text fidelity ≥ 0.85) before it enters history.

### Voice characters as reusable assets

From a reference clip the system extracts a 3–6s continuous speech segment, validates waveform and voiceprint, and only creates the character after a round-trip calibration passes.

### Dual-engine synthesis

Default **CosyVoice2** (official default voice or voice-cloned), optional **VoxCPM** (VoxCPM2 ~5.0GB / VoxCPM1.5 ~2.0GB / VoxCPM-0.5B ~1.6GB): VoxCPM2 supports 30 languages and a Voice Design default voice; VoxCPM1.5/0.5B require a character reference.

### Default voices and voice design

20 built-in Chinese style preset voices (`audio.presets`; reference audio is hosted on the CDN and cached on first use, with a bundled fallback list offline), or design a voice character from a Chinese description (age/gender + timbre + pacing + reference scene) via VoxCPM2 Voice Design (`audio.character.design`), or save a preset as your own private character.

### Connected to the Editor caption workflow

Transcripts are saved as platform `transcript` Assets (source audio + SRT + JSON bundle). The Editor reuses them via the capability bridge (`audio.transcribe` / `audio.save`) to generate caption tracks and editable scripts.

## From Idea to Finished Video

1. **Prepare the environment**: auto-setup on first open; afterwards model downloads and runtime installs are done on demand from the “Models & Environment” settings panel (top-right gear).
2. **Transcribe**: pick an audio or video Asset, model and language, generate transcript and SRT, then save as a transcript Asset.
3. **Create a voice character**: three entry points — upload a reference clip to clone, design a voice with VoxCPM2 Voice Design, or manage existing characters (preview / save / remove). You can also pick one of the 20 built-in presets, or design a voice from a description (`audio.character.design`).
4. **Synthesize**: enter text, choose engine and character (optional), preview privately and save as an audio Asset.
5. **Back to the Editor**: use subtitles and dubbing Assets on the timeline and export.

## Core Capabilities

| Capability | What you can do | Key operations |
| --- | --- | --- |
| **Local transcription** | Audio/video to timestamped transcript and SRT (auto/zh/en) | `audio.transcribe` · `audio.transcript` · `audio.transcripts` |
| **Voice characters** | Create reusable characters from a reference clip with verification | `audio.character.create` · `audio.characters` · `audio.character.remove` |
| **Default voices** | 20 Chinese style presets, fetched from CDN on demand | `audio.presets` |
| **Voice design** | Create a voice character from a Chinese description (VoxCPM2 Voice Design) or a preset | `audio.character.design` |
| **Speech synthesis** | Read new text with the default voice or a character (CosyVoice2 / VoxCPM) | `audio.synthesize` · `audio.syntheses` |
| **Save to library** | Save private transcripts/syntheses/character references as Assets | `audio.save` |
| **Environment & models** | Check Python/FFmpeg/models/engines and install on demand | `audio.status` · `audio.prepare` · `audio.install` |
| **Task center** | List, inspect and cancel all tasks (including queued); read persistent logs; inference tasks queue serially, downloads run in parallel | `audio.tasks.list` · `audio.task.get` · `audio.task.logs` · `audio.task.cancel` |

> See `manifest.json` `operations` for the full contract; operations marked `capability: true` are reusable across Apps.

## Quick Start

### Open in Recut

1. Install and launch Recut (see root [README](../../README.en.md#install-recut)).
2. Install **Audio Studio** from **Apps** and open it.
3. Complete environment setup and model downloads on first entry (`audio.status` shows progress).

### Let an Agent Help

In Claude Code / OpenCode / Codex Cli, tell your project:

> "Use Audio Studio to [transcribe this video into Chinese subtitles, save it, and generate a caption track in the Editor]. Check audio.status for readiness, call audio.transcribe, then save and place it on the timeline."

The Agent calls transcription and save via the capability bridge; results return to the media library and timeline.

## Interface Tour

- **Models & Environment settings (top-right gear)**: centrally manage the three runtimes (main / CosyVoice / VoxCPM dedicated venvs), all models (Whisper / Qwen3-ASR / CosyVoice2 / three VoxCPM tiers), download source and voice-preset cache state. Workflow steps keep only readiness status plus an “Open settings” shortcut.
- **Transcribe**: pick media and language, review segments and SRT, save as transcript Asset.
- **Voice characters**: the first-level modal offers three entry points — upload a reference clip to clone, design a voice with VoxCPM, or manage existing characters (preview / save / remove, with origin badges).
- **Synthesize**: enter text, choose engine and character, preview and save.
- **Tasks & logs**: view current and past tasks, open persistent logs, cancel running jobs.

![Audio Studio interface](./assets/audio-studio.jpg)
<sub>Transcription, voice characters and dubbing collaborate in one workspace; confirmed results enter the media library.</sub>

## FAQ

**Why can't I run multiple tasks at once?** Inference tasks (transcribe / create character / design voice / synthesize) all load large models on the same GPU, so they are serialized on a single slot. Submitting several at once never fails — later ones enter “Queued” and start automatically when the earlier one finishes (no need to resubmit). Model downloads (`audio.install`) don't contend with inference and can always run in parallel. Launcher cards and the task center label each feature's “running / queued” state.

**Transcribe or synthesize is disabled?** It may already have a queued/running task (one per feature), or a dependency isn't ready — open the “Models & Environment” settings panel (top-right gear) to see what isn't ready and install it per row; or check `audio.status` for Python, FFmpeg and model state. To repair one dedicated venv, use `audio.prepare { target: "cosyvoice" | "voxcpm" }`.

**Voice character creation failed?** The reference needs a clear, continuous speech segment. The system validates waveform and voiceprint — unverified inputs are rejected. Try a cleaner voice clip.

**VoxCPM models are large and downloads fail?** In the “Models & Environment” settings panel, switch between Hugging Face / ModelScope / automatic fallback and re-download. VoxCPM installs a dedicated venv on first use; logs are in the task center.

**Where are saved results?** Transcripts become `transcript` Assets (bundle with source audio, SRT and JSON); syntheses become audio Assets — both available in the global media library and the Editor's media panel.

## For Developers

A standalone Recut App. UI source is in `ui/` (React + TypeScript + Vite); background follows the `manifest.json` `background` and `operations` contract.

```sh
make app-link APP=apps/audio-studio
cd apps/audio-studio/ui
npm install
npm run build
```

- Runtime consumes `ui/dist/index.html`; `ui/dist/` and `node_modules/` are not committed.
- Model weights go to `~/.recut/models/audio-studio/`; venvs to `~/.recut/python/envs/recut.audio-studio/`.
- Contracts: `manifest.json` · `background.js` · `bootstrap.py` · `python/` · `skills/`.

[Back to root README](../../README.en.md) · [App Map](../../README.en.md#app-map)
