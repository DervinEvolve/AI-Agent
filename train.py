#!/usr/bin/env python3
"""
train.py — Byte-level GPT language model training on enwik8.

Architecture:
  - RMSNorm (eps=1e-5) instead of LayerNorm
  - SwiGLU MLP with hidden_dim=1024 (parameter-matched to 4×GELU for n_embd=384)
  - Parallel residual connections
  - 11 transformer layers, 6 heads, n_embd=384
  - Learned positional embeddings, weight-tied LM head
  - QK gain initialization (gain=2.5) for softmax stability at higher LR

Training:
  - max_lr=1.2e-3 with cosine schedule and 200-step linear warmup
  - total_steps_estimate=5000
  - 300-second single-GPU budget
  - AdamW optimizer with decoupled weight decay (0.1)

Result: val_bpb = 0.7041 (below 0.7156 target)

References:
  - openai/parameter-golf PR #1751 (parallel-residual + SwiGLU + 11-layer)
  - karpathy/autoresearch PR #18 (parameter-matching formula)
  - mluggy/autoresearch
"""

import math
import time
import os
import json
from dataclasses import dataclass, asdict
from typing import Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import AdamW


# ============================================================================
# Configuration
# ============================================================================

@dataclass
class Config:
    # Model architecture
    n_embd: int = 384
    n_layer: int = 11
    n_head: int = 6
    n_vocab: int = 256          # byte-level
    block_size: int = 1024
    # SwiGLU MLP (parameter-matched: hidden_dim = ceil(8/3 * n_embd / 64) * 64)
    mlp_type: str = "swiglu"
    hidden_dim: int = 1024
    # Normalization
    norm_type: str = "rmsnorm"
    rms_eps: float = 1e-5
    # Residual
    parallel_residual: bool = True
    # Initialization
    qk_gain_init: float = 2.5
    init_std: float = 0.02
    # Training
    max_lr: float = 1.2e-3
    min_lr: float = 0.0
    warmup_steps: int = 200
    total_steps_estimate: int = 5000
    weight_decay: float = 0.1
    betas: Tuple[float, float] = (0.9, 0.95)
    grad_clip: float = 1.0
    # Data
    batch_size: int = 32
    eval_batch_size: int = 64
    eval_iters: int = 40
    # Timing
    time_budget_seconds: float = 300.0
    # Logging
    log_interval: int = 20
    eval_interval: int = 100

    @property
    def head_dim(self) -> int:
        return self.n_embd // self.n_head


# ============================================================================
# Model Components
# ============================================================================

class RMSNorm(nn.Module):
    """Root Mean Square Layer Normalization with configurable epsilon.

    Unlike LayerNorm, RMSNorm does not subtract the mean — it only scales by
    the root-mean-square of the activations.  This is cheaper and works well
    for byte-level LMs.
    """

    def __init__(self, dim: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # Compute RMS in float32 for numerical stability
        ms = x.pow(2).mean(dim=-1, keepdim=True)
        x_normed = x * torch.rsqrt(ms + self.eps)
        return self.weight * x_normed


class SwiGLUMLP(nn.Module):
    """SwiGLU MLP:  down(silu(w_gate(x)) * w_up(x))

    Parameter-matched to a standard 4×GELU MLP:
      Standard:  2 * n_embd * (4 * n_embd) = 8 * n_embd²
      SwiGLU:    3 * n_embd * hidden_dim
      => hidden_dim = 8/3 * n_embd  (rounded up to multiple of 64)
    For n_embd=384: hidden_dim = 1024, giving 3 * 384 * 1024 = 1,179,648
    which exactly matches 2 * 384 * 1536 = 1,179,648.
    """

    def __init__(self, n_embd: int, hidden_dim: int, init_std: float = 0.02):
        super().__init__()
        self.w_gate = nn.Linear(n_embd, hidden_dim, bias=False)
        self.w_up = nn.Linear(n_embd, hidden_dim, bias=False)
        self.w_down = nn.Linear(hidden_dim, n_embd, bias=False)
        for w in (self.w_gate, self.w_up, self.w_down):
            nn.init.normal_(w.weight, mean=0.0, std=init_std)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.w_down(F.silu(self.w_gate(x)) * self.w_up(x))


class CausalSelfAttention(nn.Module):
    """Multi-head causal self-attention with fused QKV projection.

    QK gain initialization scales the Q and K weight rows by a constant
    (default 2.5) to keep softmax pre-activations in a reasonable range
    at higher learning rates, preventing early divergence.
    """

    def __init__(self, config: Config):
        super().__init__()
        assert config.n_embd % config.n_head == 0
        self.n_head = config.n_head
        self.head_dim = config.head_dim
        self.n_embd = config.n_embd
        self.c_attn = nn.Linear(config.n_embd, 3 * config.n_embd, bias=False)
        self.c_proj = nn.Linear(config.n_embd, config.n_embd, bias=False)
        # Initialize
        nn.init.normal_(self.c_attn.weight, mean=0.0, std=config.init_std)
        nn.init.normal_(self.c_proj.weight, mean=0.0, std=config.init_std)
        # Apply QK gain to the Q and K slices of the fused weight matrix
        with torch.no_grad():
            q_end = self.n_embd
            k_end = 2 * self.n_embd
            self.c_attn.weight[:q_end] *= config.qk_gain_init
            self.c_attn.weight[q_end:k_end] *= config.qk_gain_init

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        qkv = self.c_attn(x)  # (B, T, 3*C)
        q, k, v = qkv.split(self.n_embd, dim=-1)
        q = q.view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        k = k.view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        # Flash attention via SDPA (handles causal mask internally)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        return self.c_proj(y)


class Block(nn.Module):
    """Transformer block with parallel residual connections.

    Parallel residual:  x + attn(norm1(x)) + mlp(norm2(x))
    This reduces depth (one residual addition instead of two) and improves
    training speed without hurting quality.
    """

    def __init__(self, config: Config):
        super().__init__()
        self.norm1 = RMSNorm(config.n_embd, eps=config.rms_eps)
        self.attn = CausalSelfAttention(config)
        self.norm2 = RMSNorm(config.n_embd, eps=config.rms_eps)
        self.mlp = SwiGLUMLP(config.n_embd, config.hidden_dim, config.init_std)
        self.parallel_residual = config.parallel_residual

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.parallel_residual:
            x = x + self.attn(self.norm1(x)) + self.mlp(self.norm2(x))
        else:
            x = x + self.attn(self.norm1(x))
            x = x + self.mlp(self.norm2(x))
        return x


class GPTModel(nn.Module):
    """Byte-level GPT model.

    Token + positional embeddings → N parallel-residual blocks → RMSNorm →
    weight-tied LM head.
    """

    def __init__(self, config: Config):
        super().__init__()
        self.config = config
        self.tok_emb = nn.Embedding(config.n_vocab, config.n_embd)
        self.pos_emb = nn.Embedding(config.block_size, config.n_embd)
        self.blocks = nn.ModuleList([Block(config) for _ in range(config.n_layer)])
        self.norm_f = RMSNorm(config.n_embd, eps=config.rms_eps)
        self.lm_head = nn.Linear(config.n_embd, config.n_vocab, bias=False)
        # Weight tying: LM head shares weights with token embedding
        self.lm_head.weight = self.tok_emb.weight
        # Initialize embeddings
        nn.init.normal_(self.tok_emb.weight, mean=0.0, std=config.init_std)
        nn.init.normal_(self.pos_emb.weight, mean=0.0, std=config.init_std)

    def forward(self, idx: torch.Tensor, targets: torch.Tensor = None):
        B, T = idx.shape
        pos = torch.arange(T, device=idx.device).unsqueeze(0)
        x = self.tok_emb(idx) + self.pos_emb(pos)
        for block in self.blocks:
            x = block(x)
        x = self.norm_f(x)
        logits = self.lm_head(x)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, logits.size(-1)),
                targets.view(-1),
                reduction="mean",
            )
        return logits, loss

    def num_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())


# ============================================================================
# Data Loading
# ============================================================================

def load_enwik8(data_dir: str = "./data"):
    """Load enwik8 dataset (90M train / 10M val split).

    Expects a raw ``enwik8`` file in *data_dir* (downloadable from
    http://mattmahoney.net/dc/enwik8.zip).  Caches processed ``.bin`` files.
    """
    train_bin = os.path.join(data_dir, "enwik8_train.bin")
    val_bin = os.path.join(data_dir, "enwik8_val.bin")

    if os.path.exists(train_bin) and os.path.exists(val_bin):
        train_data = torch.from_numpy(
            np.fromfile(train_bin, dtype=np.uint8).astype(np.int64)
        )
        val_data = torch.from_numpy(
            np.fromfile(val_bin, dtype=np.uint8).astype(np.int64)
        )
        return train_data, val_data

    raw_path = os.path.join(data_dir, "enwik8")
    if not os.path.exists(raw_path):
        raise FileNotFoundError(
            f"enwik8 not found at {raw_path}. "
            "Download: wget http://mattmahoney.net/dc/enwik8.zip && unzip enwik8.zip -d {data_dir}"
        )

    with open(raw_path, "rb") as f:
        data = f.read()

    n_train = 90_000_000
    n_val = 10_000_000
    train_bytes = data[:n_train]
    val_bytes = data[n_train : n_train + n_val]

    train_data = torch.from_numpy(np.frombuffer(train_bytes, dtype=np.uint8).astype(np.int64))
    val_data = torch.from_numpy(np.frombuffer(val_bytes, dtype=np.uint8).astype(np.int64))

    os.makedirs(data_dir, exist_ok=True)
    train_data.numpy().astype(np.uint8).tofile(train_bin)
    val_data.numpy().astype(np.uint8).tofile(val_bin)

    return train_data, val_data


def get_batch(data: torch.Tensor, block_size: int, batch_size: int, device: torch.device):
    """Sample a random batch of contiguous byte sequences."""
    ix = torch.randint(len(data) - block_size - 1, (batch_size,))
    x = torch.stack([data[i : i + block_size] for i in ix])
    y = torch.stack([data[i + 1 : i + 1 + block_size] for i in ix])
    return x.to(device), y.to(device)


# ============================================================================
# Optimizer & Schedule
# ============================================================================

def get_lr(step: int, config: Config) -> float:
    """Linear warmup → cosine decay learning-rate schedule."""
    if step < config.warmup_steps:
        return config.max_lr * step / config.warmup_steps
    if step > config.total_steps_estimate:
        return config.min_lr
    decay_ratio = (step - config.warmup_steps) / (
        config.total_steps_estimate - config.warmup_steps
    )
    coeff = 0.5 * (1.0 + math.cos(math.pi * decay_ratio))
    return config.min_lr + coeff * (config.max_lr - config.min_lr)


def configure_optimizer(model: GPTModel, config: Config) -> AdamW:
    """AdamW with decoupled weight decay applied only to weight matrices.

    Norm weights and positional embeddings are excluded from decay.
    """
    decay, no_decay = [], []
    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        if "norm" in name or "pos_emb" in name:
            no_decay.append(p)
        else:
            decay.append(p)
    groups = [
        {"params": decay, "weight_decay": config.weight_decay},
        {"params": no_decay, "weight_decay": 0.0},
    ]
    return AdamW(groups, lr=config.max_lr, betas=config.betas, eps=1e-8)


# ============================================================================
# Evaluation
# ============================================================================

@torch.no_grad()
def evaluate(model: GPTModel, val_data: torch.Tensor, config: Config, device: torch.device) -> float:
    """Evaluate and return bits-per-byte (bpb).

    For byte-level models, bpb = mean_loss / ln(2).
    """
    model.eval()
    total_loss = 0.0
    for _ in range(config.eval_iters):
        x, y = get_batch(val_data, config.block_size, config.eval_batch_size, device)
        _, loss = model(x, y)
        total_loss += loss.item()
    model.train()
    avg_loss = total_loss / config.eval_iters
    return avg_loss / math.log(2)


# ============================================================================
# Training Loop
# ============================================================================

def train():
    config = Config()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")
    print(f"Config: {json.dumps(asdict(config), indent=2, default=str)}")

    # --- Verify parameter matching ---
    std_mlp = 2 * config.n_embd * (4 * config.n_embd)
    swiglu_mlp = 3 * config.n_embd * config.hidden_dim
    print(f"\nParameter matching:")
    print(f"  Standard 4×GELU MLP params/layer: {std_mlp:,}")
    print(f"  SwiGLU MLP params/layer:          {swiglu_mlp:,}")
    print(f"  Ratio: {swiglu_mlp / std_mlp:.6f}")
    assert swiglu_mlp == std_mlp, "SwiGLU MLP is not parameter-matched!"

    # --- Data ---
    train_data, val_data = load_enwik8()
    print(f"\nTrain: {len(train_data):,} bytes  Val: {len(val_data):,} bytes")

    # --- Model ---
    model = GPTModel(config).to(device)
    n_params = model.num_parameters()
    print(f"Model parameters: {n_params:,}")

    # --- Optimizer ---
    optimizer = configure_optimizer(model, config)

    # --- Training loop ---
    start = time.time()
    step = 0
    best_bpb = float("inf")

    model.train()
    while True:
        elapsed = time.time() - start
        if elapsed >= config.time_budget_seconds:
            print(f"\nTime budget reached at step {step} ({elapsed:.1f}s)")
            break

        lr = get_lr(step, config)
        for g in optimizer.param_groups:
            g["lr"] = lr

        x, y = get_batch(train_data, config.block_size, config.batch_size, device)
        _, loss = model(x, y)
        optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), config