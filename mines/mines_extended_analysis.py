"""
Mines Extended Analysis: EV, Variance, and Visualization
=========================================================
Companion to mines_simulator.py. Computes theoretical probability tables
for arbitrary board sizes, demonstrates the EV structure of cash-out
decisions, and produces charts comparing theory with simulation.
"""

import hmac, hashlib, math
from collections import Counter
from itertools import count as icount

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats

RTP = 0.99

# ---------- theory, generalized to any board size ----------

def p_survive(picks, mines, tiles=25):
    p = 1.0
    for i in range(picks):
        p *= (tiles - mines - i) / (tiles - i)
    return p

def multiplier(picks, mines, tiles=25, rtp=RTP):
    return rtp / p_survive(picks, mines, tiles)

def variance_per_unit(picks, mines, tiles=25, rtp=RTP):
    """Variance of return per unit staked when cashing out after `picks`."""
    p = p_survive(picks, mines, tiles)
    m = rtp / p
    # outcome: m with prob p, 0 with prob (1-p); E = rtp
    return p * m**2 - rtp**2

# ---------- provably-fair generator (same as simulator) ----------

def mine_positions(server_seed, client_seed, nonce, mines, tiles=25):
    def gen():
        for cur in icount(0):
            d = hmac.new(server_seed.encode(),
                         f"{client_seed}:{nonce}:{cur}".encode(),
                         hashlib.sha256).digest()
            yield from d
    g = gen()
    remaining = list(range(tiles))
    out = []
    for _ in range(mines):
        f = sum(next(g) / 256 ** (i + 1) for i in range(4))
        out.append(remaining.pop(int(f * len(remaining))))
    return out

# ---------- 1. probability & multiplier tables ----------

print("THEORETICAL TABLES (25-tile board)")
print("=" * 78)
for mines in (1, 3, 5, 10, 24):
    max_picks = 25 - mines
    rows = []
    for k in (1, 2, 3, 5, 8, max_picks):
        if k > max_picks: continue
        p = p_survive(k, mines)
        rows.append(f"  picks={k:>2}  P={p:.6f}  mult=x{multiplier(k, mines):>10.2f}  "
                    f"sd={math.sqrt(variance_per_unit(k, mines)):>10.2f}")
    print(f"\n{mines} mines (max picks {max_picks}):")
    print("\n".join(rows))

# board-size comparison
print("\n\nBOARD-SIZE COMPARISON: P(survive 3 picks), 3 mines")
for tiles in (9, 16, 25, 36, 49):
    print(f"  {tiles:>2} tiles: P = {p_survive(3, 3, tiles):.5f}  "
          f"mult = x{multiplier(3, 3, tiles):.4f}")

# ---------- 2. conditional EV: the martingale property ----------

print("\n\nCONDITIONAL EV: cash out now vs continue one more pick (3 mines)")
print("=" * 78)
print(f"{'k':>3} {'mult now':>10} {'P(next safe)':>13} {'mult k+1':>10} "
      f"{'EV continue':>12} {'difference':>11}")
for k in range(0, 10):
    m_now = multiplier(k, 3) if k > 0 else 1.0   # k=0: stake not yet risked... use 0.99 base
    m_now = RTP / p_survive(k, 3)                 # generalised: k=0 -> 0.99
    p_next = (25 - 3 - k) / (25 - k)
    m_next = multiplier(k + 1, 3)
    ev_cont = p_next * m_next
    print(f"{k:>3} {m_now:>10.4f} {p_next:>13.4f} {m_next:>10.4f} "
          f"{ev_cont:>12.4f} {ev_cont - m_now:>11.2e}")

# ---------- 3. simulation for empirical comparison ----------

N_GAMES = 100_000
SS, CS = "research_server_seed_demo", "research_client_seed"
MINES = 3

cell_hits = Counter()
survived_k = np.zeros(23, dtype=int)   # how many games survived at least k picks (picking tiles 0..k-1)
for nonce in range(N_GAMES):
    pos = set(mine_positions(SS, CS, nonce, MINES))
    cell_hits.update(pos)
    for k in range(1, 23):
        if any(t in pos for t in range(k)):
            break
        survived_k[k] += 1

emp_p = survived_k[1:11] / N_GAMES
theo_p = np.array([p_survive(k, MINES) for k in range(1, 11)])

# ---------- 4. charts ----------

plt.rcParams.update({"figure.dpi": 130, "font.size": 9})

# chart 1: survival curves for several mine counts + empirical overlay
fig, ax = plt.subplots(figsize=(7, 4.2))
for m, c in zip((1, 3, 5, 10), ("#2a9d8f", "#e76f51", "#264653", "#e9c46a")):
    ks = range(1, 25 - m + 1)
    ax.plot(list(ks), [p_survive(k, m) for k in ks], label=f"{m} mines", color=c)
ax.scatter(range(1, 11), emp_p, s=28, zorder=5, color="#e76f51",
           marker="x", label="simulated (3 mines, 100k games)")
ax.set_xlabel("consecutive safe picks (k)"); ax.set_ylabel("P(survive k picks)")
ax.set_title("Hypergeometric survival probability — theory vs simulation")
ax.legend(); ax.grid(alpha=0.3)
fig.tight_layout(); fig.savefig("survival_curves.png")

# chart 2: EV flat vs standard deviation exploding
fig, ax1 = plt.subplots(figsize=(7, 4.2))
ks = list(range(1, 21))
ev = [RTP] * len(ks)
sd = [math.sqrt(variance_per_unit(k, 3)) for k in ks]
ax1.plot(ks, ev, color="#2a9d8f", lw=2, label="Expected value (always 0.99)")
ax1.set_ylim(0, 1.2); ax1.set_xlabel("cash-out depth (picks)")
ax1.set_ylabel("EV per unit staked", color="#2a9d8f")
ax2 = ax1.twinx()
ax2.plot(ks, sd, color="#e76f51", lw=2, ls="--", label="Std deviation")
ax2.set_ylabel("standard deviation per unit staked", color="#e76f51")
ax2.set_yscale("log")
ax1.set_title("Cash-out depth changes variance, never EV (3 mines)")
fig.legend(loc="upper left", bbox_to_anchor=(0.12, 0.88))
ax1.grid(alpha=0.3)
fig.tight_layout(); fig.savefig("ev_vs_variance.png")

# chart 3: 5x5 heatmap of empirical mine frequency
freq = np.array([cell_hits[i] for i in range(25)]).reshape(5, 5) / (N_GAMES * MINES / 25)
fig, ax = plt.subplots(figsize=(4.6, 4.2))
im = ax.imshow(freq, cmap="RdBu_r", vmin=0.96, vmax=1.04)
for i in range(5):
    for j in range(5):
        ax.text(j, i, f"{freq[i, j]:.3f}", ha="center", va="center", fontsize=8)
ax.set_title(f"Mine frequency vs expectation\n({N_GAMES:,} games, 1.000 = perfectly uniform)")
ax.set_xticks([]); ax.set_yticks([])
fig.colorbar(im, shrink=0.8)
fig.tight_layout(); fig.savefig("cell_heatmap.png")

# chart 4: rolling win rate with 99% confidence band
window = 2000
outcomes = np.array([1 if survived else 0 for survived in
                     (not any(t in set(mine_positions(SS, CS, n, MINES)) for t in range(3))
                      for n in range(30_000))])
roll = np.convolve(outcomes, np.ones(window) / window, mode="valid")
p0 = p_survive(3, MINES)
band = 2.576 * math.sqrt(p0 * (1 - p0) / window)
fig, ax = plt.subplots(figsize=(7, 4.2))
ax.plot(roll, lw=0.8, color="#264653", label=f"rolling win rate (window={window})")
ax.axhline(p0, color="#2a9d8f", lw=1.5, label=f"theoretical {p0:.4f}")
ax.fill_between(range(len(roll)), p0 - band, p0 + band, alpha=0.18, color="#2a9d8f",
                label="99% band for an honest RNG")
ax.set_xlabel("game number"); ax.set_ylabel("win rate")
ax.set_title("Rolling win rate — drift outside the band would indicate bias")
ax.legend(); ax.grid(alpha=0.3)
fig.tight_layout(); fig.savefig("rolling_winrate.png")

# chi-square on this run
obs = [cell_hits[i] for i in range(25)]
chi2, p_chi = stats.chisquare(obs)
print(f"\nchi-square on {N_GAMES:,} games: chi2={chi2:.2f}, p={p_chi:.4f}")
print("charts saved.")
