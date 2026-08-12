"""
[INPUT]: 依赖 vendored assets/mel_filters.npz、torch、numpy 与 tiktoken（CosyVoice 自带 tokenizer 使用）
[OUTPUT]: 对外提供注入 sys.modules 的 whisper（log_mel_spectrogram）与 whisper.tokenizer（Tokenizer）兼容层、modelscope 的 snapshot_download 占位，以及替换 CosyVoice load_wav 的 soundfile 实现
[POS]: audio_runner 的依赖兼容边界；用 vendored 权重替代 openai-whisper 源码安装，绝不触发网络下载，load_wav 兼容 torchaudio>=2.9（已移除 soundfile 后端）
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""
from __future__ import annotations

import os
import sys
import types
from dataclasses import dataclass, field
from functools import cached_property
from typing import Dict, List, Optional, Tuple

LANGUAGES = {
    "en": "english", "zh": "chinese", "de": "german", "es": "spanish", "ru": "russian",
    "ko": "korean", "fr": "french", "ja": "japanese", "pt": "portuguese", "tr": "turkish",
    "pl": "polish", "ca": "catalan", "nl": "dutch", "ar": "arabic", "sv": "swedish",
    "it": "italian", "id": "indonesian", "hi": "hindi", "fi": "finnish", "vi": "vietnamese",
    "he": "hebrew", "uk": "ukrainian", "el": "greek", "ms": "malay", "cs": "czech",
    "ro": "romanian", "da": "danish", "hu": "hungarian", "ta": "tamil", "no": "norwegian",
    "th": "thai", "ur": "urdu", "hr": "croatian", "bg": "bulgarian", "lt": "lithuanian",
    "la": "latin", "mi": "maori", "ml": "malayalam", "cy": "welsh", "sk": "slovak",
    "te": "telugu", "fa": "persian", "lv": "latvian", "bn": "bengali", "sr": "serbian",
    "az": "azerbaijani", "sl": "slovenian", "kn": "kannada", "et": "estonian", "mk": "macedonian",
    "br": "breton", "eu": "basque", "is": "icelandic", "hy": "armenian", "ne": "nepali",
    "mn": "mongolian", "bs": "bosnian", "kk": "kazakh", "sq": "albanian", "sw": "swahili",
    "gl": "galician", "mr": "marathi", "pa": "punjabi", "si": "sinhala", "km": "khmer",
    "sn": "shona", "yo": "yoruba", "so": "somali", "af": "afrikaans", "oc": "occitan",
    "ka": "georgian", "be": "belarusian", "tg": "tajik", "sd": "sindhi", "gu": "gujarati",
    "am": "amharic", "yi": "yiddish", "lo": "lao", "uz": "uzbek", "fo": "faroese",
    "ht": "haitian creole", "ps": "pashto", "tk": "turkmen", "nn": "nynorsk", "mt": "maltese",
    "sa": "sanskrit", "lb": "luxembourgish", "my": "myanmar", "bo": "tibetan", "tl": "tagalog",
    "mg": "malagasy", "as": "assamese", "tt": "tatar", "haw": "hawaiian", "ln": "lingala",
    "ha": "hausa", "ba": "bashkir", "jw": "javanese", "su": "sundanese", "yue": "cantonese",
}

TO_LANGUAGE_CODE = {
    **{language: code for code, language in LANGUAGES.items()},
    "burmese": "my", "valencian": "ca", "flemish": "nl", "haitian": "ht",
    "letzeburgesch": "lb", "pushto": "ps", "panjabi": "pa", "moldavian": "ro",
    "moldovan": "ro", "sinhalese": "si", "castilian": "es", "mandarin": "zh",
}

N_FFT = 400
HOP_LENGTH = 160


@dataclass
class Tokenizer:
    """Faithful copy of openai-whisper's tokenizer.Tokenizer used by CosyVoice."""

    encoding: object
    num_languages: int
    language: Optional[str] = None
    task: Optional[str] = None
    sot_sequence: Tuple[int] = ()
    special_tokens: Dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for special in self.encoding.special_tokens_set:
            self.special_tokens[special] = self.encoding.encode_single_token(special)
        sot = self.special_tokens["<|startoftranscript|>"]
        translate = self.special_tokens["<|translate|>"]
        transcribe = self.special_tokens["<|transcribe|>"]
        langs = tuple(LANGUAGES.keys())[: self.num_languages]
        sot_sequence = [sot]
        if self.language is not None:
            sot_sequence.append(sot + 1 + langs.index(self.language))
        if self.task is not None:
            sot_sequence.append(transcribe if self.task == "transcribe" else translate)
        self.sot_sequence = tuple(sot_sequence)

    def encode(self, text: str, **kwargs: object) -> List[int]:
        return self.encoding.encode(text, **kwargs)

    def decode(self, token_ids: List[int], **kwargs: object) -> str:
        return self.encoding.decode([token for token in token_ids if token < self.timestamp_begin], **kwargs)

    def decode_with_timestamps(self, token_ids: List[int], **kwargs: object) -> str:
        return self.encoding.decode(token_ids, **kwargs)

    @cached_property
    def eot(self) -> int:
        return self.encoding.eot_token

    @cached_property
    def transcribe(self) -> int:
        return self.special_tokens["<|transcribe|>"]

    @cached_property
    def translate(self) -> int:
        return self.special_tokens["<|translate|>"]

    @cached_property
    def sot(self) -> int:
        return self.special_tokens["<|startoftranscript|>"]

    @cached_property
    def sot_lm(self) -> int:
        return self.special_tokens["<|startoflm|>"]

    @cached_property
    def sot_prev(self) -> int:
        return self.special_tokens["<|startofprev|>"]

    @cached_property
    def no_speech(self) -> int:
        return self.special_tokens["<|nospeech|>"]

    @cached_property
    def no_timestamps(self) -> int:
        return self.special_tokens["<|notimestamps|>"]

    @cached_property
    def timestamp_begin(self) -> int:
        return self.special_tokens["<|0.00|>"]

    @cached_property
    def language_token(self) -> int:
        if self.language is None:
            raise ValueError("This tokenizer does not have language token configured")
        return self.to_language_token(self.language)

    def to_language_token(self, language: str) -> int:
        token = self.special_tokens.get(f"<|{language}|>")
        if token is not None:
            return token
        raise KeyError(f"Language {language} not found in tokenizer.")

    @cached_property
    def all_language_tokens(self) -> Tuple[int, ...]:
        result = [token_id for token, token_id in self.special_tokens.items() if token.strip("<|>") in LANGUAGES]
        return tuple(result)[: self.num_languages]

    @cached_property
    def sot_sequence_including_notimestamps(self) -> Tuple[int, ...]:
        return tuple(list(self.sot_sequence) + [self.no_timestamps])


def install_whisper() -> None:
    """Injects a whisper module with the exact openai-whisper mel + tokenizer API."""
    if "whisper" in sys.modules:
        return
    assets = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

    def log_mel_spectrogram(audio, n_mels: int = 80, padding: int = 0, device: object = None):
        import numpy as np
        import torch
        import torch.nn.functional as F

        if not torch.is_tensor(audio):
            audio = torch.from_numpy(audio)
        if device is not None:
            audio = audio.to(device)
        if padding > 0:
            audio = F.pad(audio, (0, padding))
        window = torch.hann_window(N_FFT).to(audio.device)
        stft = torch.stft(audio, N_FFT, HOP_LENGTH, window=window, return_complex=True)
        magnitudes = stft[..., :-1].abs() ** 2
        with np.load(os.path.join(assets, "mel_filters.npz")) as filters_file:
            filters = torch.from_numpy(filters_file[f"mel_{n_mels}"]).to(audio.device)
        mel_spec = filters @ magnitudes
        log_spec = torch.clamp(mel_spec, min=1e-10).log10()
        log_spec = torch.maximum(log_spec, log_spec.max() - 8.0)
        log_spec = (log_spec + 4.0) / 4.0
        return log_spec

    whisper = types.ModuleType("whisper")
    whisper.log_mel_spectrogram = log_mel_spectrogram
    whisper.LANGUAGES = LANGUAGES
    whisper.TO_LANGUAGE_CODE = TO_LANGUAGE_CODE
    sys.modules["whisper"] = whisper

    tokenizer = types.ModuleType("whisper.tokenizer")
    tokenizer.Tokenizer = Tokenizer
    tokenizer.LANGUAGES = LANGUAGES
    tokenizer.TO_LANGUAGE_CODE = TO_LANGUAGE_CODE
    sys.modules["whisper.tokenizer"] = tokenizer
    whisper.tokenizer = tokenizer


def install_modelscope() -> None:
    """Injects a modelscope snapshot_download stub; CosyVoice only imports it for model downloads we never invoke."""
    if "modelscope" in sys.modules:
        return
    module = types.ModuleType("modelscope")

    def snapshot_download(model_id: str, local_dir: Optional[str] = None, **kwargs: object) -> str:
        return local_dir if local_dir is not None else model_id

    module.snapshot_download = snapshot_download
    sys.modules["modelscope"] = module


def install_load_wav() -> None:
    """Replaces CosyVoice's torchaudio-backed load_wav with a soundfile-based one.

    torchaudio >= 2.9 removed the soundfile backend that
    cosyvoice.utils.file_utils.load_wav passes as backend='soundfile', so a
    reference wav/tensor must round-trip through the soundfile package instead.
    Patch the module before cosyvoice.cli.frontend is imported so its
    `from cosyvoice.utils.file_utils import load_wav` binding picks it up.
    """
    import torch
    import torchaudio
    import cosyvoice.utils.file_utils as file_utils

    def load_wav(wav, target_sr, min_sr=16000):
        import soundfile as sf

        if isinstance(wav, torch.Tensor):
            speech = wav.detach().cpu()
            sample_rate = 16000
        else:
            data, sample_rate = sf.read(str(wav), dtype="float32", always_2d=True)
            speech = torch.from_numpy(data.T)
        if speech.dim() == 1:
            speech = speech.unsqueeze(0)
        if speech.dim() == 2 and speech.shape[0] != 1:
            speech = speech.mean(dim=0, keepdim=True)
        if sample_rate != target_sr:
            assert sample_rate >= min_sr, f"wav sample rate {sample_rate} must be greater than {min_sr}"
            speech = torchaudio.transforms.Resample(orig_freq=sample_rate, new_freq=target_sr)(speech)
        return speech

    file_utils.load_wav = load_wav
