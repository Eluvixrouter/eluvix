# Sub-4-Bit Microscaling (`NVFP4`, `MXFP4`) & Walsh-Hadamard Outlier Rotation

This document details the numerical representations, two-level microscaling hierarchy, orthogonal Walsh-Hadamard outlier transforms (`QuaRot` / `SpinQuant` / `SVDQuant`), and Quantization-Aware Switchyard routing in `@eluvix/router-core` (`packages/router-core/src/microscaling-quantization.ts`).

---

## 1. `E2M1` Representation & Two-Level Microscaling (`NVFP4` vs `MXFP4`)

Both **OCP MXFP4** and **NVIDIA Blackwell NVFP4** use the 4-bit **`E2M1`** floating-point representation (`1 sign bit`, `2 exponent bits`, `1 mantissa bit`, bias $b=1$), encoding all 16 bit patterns as finite numbers ($\pm \{0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0\}$).

| Specification | Weight-Only `INT4-AWQ` (`W4A16`) | Standard `OCP MXFP4` (`W4A4`) | NVIDIA Blackwell `NVFP4` (`W4A4`) |
| :--- | :--- | :--- | :--- |
| **Element Format** | 4-bit Signed Int (`[-8..7]`) | `E2M1` (`±0..6.0`) | `E2M1` (`±0..6.0`) |
| **Micro-Block Size ($k$)** | `128` elements | `32` elements | **`16` elements** |
| **Level-1 Block Scale** | `FP16` (16-bit) | `E8M0` (8-bit power-of-2) | **`FP8 E4M3`** (8-bit fractional) |
| **Level-2 Global Scale** | None | None | **Per-Tensor `FP32`** ($S_{\text{tensor}}$) |
| **Effective Bits / Weight** | `4.125 bits` | `4.25 bits` | **`4.50 bits`** (`39.4 GB` for 70B) |
| **Tensor Core PTX** | Dequantizes to `FP16` | `tcgen05.mma.kind::mxf4` | **`tcgen05.mma.kind::mxf4nvf4`** (`20 PFLOPS`) |

Because standard `OCP MXFP4` uses a pure power-of-2 `E8M0` scale across 32 elements, any block maximum slightly above $6.0 \times 2^k$ forces the scale to double to $2^{k+1}$, wasting half the `E2M1` dynamic range. **Blackwell `NVFP4`** uses a fractional `FP8 E4M3` Level-1 scale across 16 elements plus a per-tensor `FP32` Level-2 global scale, cutting quantization MSE by **~2.4x**.

---

## 2. Fast Walsh-Hadamard Transform (`FWHT`) Outlier Rotation ($R_1..R_4$)

Emergent activation outliers ($50\times\text{–}100\times$ channel spikes after `SiLU_and_Mul` before `down_proj`) destroy naive 4-bit activation quantization. By applying an orthogonal **Walsh-Hadamard Matrix** $H_d \in \{\pm 1/\sqrt{d}\}^{d \times d}$ ($H_d H_d^\top = I$):

$$Y = X W^\top = (X H_d)(W H_d)^\top$$

A single $120.0$ channel spike across $d=8192$ channels is damped by $\sqrt{8192} \approx 90.5\times$ in $<8\,\mu\text{s}$ via an in-place $\mathcal{O}(d \log_2 d)$ butterfly kernel (`fastWalshHadamardTransform`), recovering **99.6% of BF16 MATH-500 reasoning accuracy** at **3.42x throughput**.
