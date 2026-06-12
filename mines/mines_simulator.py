"""
Mines Provably-Fair Simulator & Statistical Analysis Suite
===========================================================
Faithfully implements the documented provably-fair pipeline used by
Stake-style Mines games, then runs statistical tests to compare
observed results against theoretical predictions.

Pipeline: HMAC-SHA256(server_seed, f"{client_seed}:{nonce}:{round}")
          -> bytes -> floats in [0,1) -> partial Fisher-Yates tile draw

Educational/research use: probability theory, randomness verification.
"""

import hmac
import hashlib
import math
from collections import Counter
from itertools import count

from scipy import stats

TILES = 25


# ---------------------------------------------------------------------------
# 1. Core provably-fair byte/float generation (Stake's documented method)
# ---------------------------------------------------------------------------

def byte_generator(server_seed: str, client_seed: str, nonce: int):
    """Yield an unbounded stream of bytes via HMAC-SHA256 chaining.

    Each 'round' of the cursor produces 32 bytes:
        HMAC_SHA256(key=server_seed, msg=f"{client_seed}:{nonce}:{round}")
    """
    for cur in count(0):
        digest = hmac.new(
            server_seed.encode(),
            f"{client_seed}:{nonce}:{cur}".encode(),
            hashlib.sha256,
        ).digest()
        yield from digest


def floats(server_seed: str, client_seed: str, nonce: int, n: int):
    """Convert groups of 4 bytes into n floats uniform on [0, 1)."""
    gen = byte_generator(server_seed, client_seed, nonce)
    out = []
    for _ in range(n):
        chunk = [next(gen) for _ in range(4)]
        out.append(sum(b / 256 ** (i + 1) for i, b in enumerate(chunk)))
    return out


def mine_positions(server_seed: str, client_seed: str, nonce: int, mines: int):
    """Select mine tiles via partial Fisher-Yates over 25 tiles."""
    fs = floats(server_seed, client_seed, nonce, mines)
    remaining = list(range(TILES))
    chosen = []
    for f in fs:
        idx = int(f * len(remaining))
        chosen.append(remaining.pop(idx))
    return sorted(chosen)


# ---------------------------------------------------------------------------
# 2. Theoretical probabilities (hypergeometric)
# ---------------------------------------------------------------------------

def p_survive(picks: int, mines: int) -> float:
    """P(first `picks` tiles are all safe) with `mines` mines on 25 tiles."""
    p = 1.0
    for i in range(picks):
        p *= (TILES - mines - i) / (TILES - i)
    return p


def fair_multiplier(picks: int, mines: int) -> float:
    return 1.0 / p_survive(picks, mines)


def stake_multiplier(picks: int, mines: int, rtp: float = 0.99) -> float:
    return rtp / p_survive(picks, mines)


# ---------------------------------------------------------------------------
# 3. Verification helper (what a player runs after seed rotation)
# ---------------------------------------------------------------------------

def verify_commitment(revealed_server_seed: str, committed_hash: str) -> bool:
    return hashlib.sha256(revealed_server_seed.encode()).hexdigest() == committed_hash


# ---------------------------------------------------------------------------
# 4. Simulation + statistical battery
# ---------------------------------------------------------------------------

def run_analysis(n_games=200_000, mines=3, picks=3, server_seed="research_server_seed_demo", client_seed="research_client_seed"):
    print(f"Simulating {n_games:,} games | {mines} mines | cash-out after {picks} safe picks")
    print("=" * 72)

    # -- commitment demo --------------------------------------------------
    commitment = hashlib.sha256(server_seed.encode()).hexdigest()
    print(f"\n[Commitment] SHA-256(server_seed) = {commitment[:32]}...")
    print(f"[Verify]     matches after reveal: {verify_commitment(server_seed, commitment)}")

    # -- generate games ----------------------------------------------------
    cell_hits = Counter()
    raw_floats = []
    outcomes = []          # 1 = survived `picks` picks (always picking tiles 0..picks-1)
    target = set(range(picks))

    for nonce in range(n_games):
        pos = mine_positions(server_seed, client_seed, nonce, mines)
        cell_hits.update(pos)
        if nonce < 50_000:  # keep memory sane; 150k floats is plenty for KS
            raw_floats.extend(floats(server_seed, client_seed, nonce, mines))
        outcomes.append(0 if target & set(pos) else 1)

    # -- (a) chi-square uniformity of mine positions ----------------------
    observed = [cell_hits[i] for i in range(TILES)]
    expected = n_games * mines / TILES
    chi2, p_chi = stats.chisquare(observed)
    print(f"\n[Chi-square] mine-position uniformity across 25 cells")
    print(f"  expected per cell: {expected:,.0f} | observed range: {min(observed):,}-{max(observed):,}")
    print(f"  chi2 = {chi2:.2f} (df=24), p = {p_chi:.4f}  ->  "
          f"{'consistent with uniform' if p_chi > 0.01 else 'REJECTS uniformity'}")

    # -- (b) KS test on raw floats ----------------------------------------
    ks, p_ks = stats.kstest(raw_floats, "uniform")
    print(f"\n[KS test] {len(raw_floats):,} raw floats vs Uniform(0,1)")
    print(f"  D = {ks:.5f}, p = {p_ks:.4f}  ->  "
          f"{'consistent with uniform' if p_ks > 0.01 else 'REJECTS uniformity'}")

    # -- (c) win rate vs hypergeometric theory ----------------------------
    p_theory = p_survive(picks, mines)
    wins = sum(outcomes)
    p_obs = wins / n_games
    se = math.sqrt(p_theory * (1 - p_theory) / n_games)
    z = (p_obs - p_theory) / se
    print(f"\n[Win rate] survive {picks} picks with {mines} mines")
    print(f"  theoretical: {p_theory:.5f} | observed: {p_obs:.5f} | z = {z:+.2f}")

    # -- (d) runs test for serial independence ----------------------------
    runs = 1 + sum(outcomes[i] != outcomes[i - 1] for i in range(1, len(outcomes)))
    n1, n0 = wins, n_games - wins
    mu = 2 * n1 * n0 / n_games + 1
    var = 2 * n1 * n0 * (2 * n1 * n0 - n_games) / (n_games ** 2 * (n_games - 1))
    z_runs = (runs - mu) / math.sqrt(var)
    print(f"\n[Runs test] serial independence of win/loss sequence")
    print(f"  runs = {runs:,} | expected = {mu:,.0f} | z = {z_runs:+.2f}  ->  "
          f"{'independent' if abs(z_runs) < 2.58 else 'POSSIBLE serial dependence'}")

    # -- (e) longest streaks vs theory -------------------------------------
    def longest(seq, val):
        best = cur = 0
        for x in seq:
            cur = cur + 1 if x == val else 0
            best = max(best, cur)
        return best

    exp_lose = math.log(n_games) / math.log(1 / p_theory) if p_theory < 1 else 0
    exp_win = math.log(n_games) / math.log(1 / (1 - p_theory))
    print(f"\n[Streaks] longest observed vs ~log-predicted")
    print(f"  losing: observed {longest(outcomes, 0)}, predicted ~{exp_win:.1f}")
    print(f"  winning: observed {longest(outcomes, 1)}, predicted ~{exp_lose:.1f}")

    # -- (f) house edge ----------------------------------------------------
    mult = stake_multiplier(picks, mines)
    ev = p_theory * mult
    print(f"\n[Economics] multiplier for this line: x{mult:.4f} "
          f"(fair would be x{fair_multiplier(picks, mines):.4f})")
    print(f"  expected return per unit staked: {ev:.4f}  ->  house edge {1 - ev:.2%}")
    print(f"  NOTE: edge is identical at every mine count / cash-out depth.")


if __name__ == "__main__":
    run_analysis()
print(mine_positions(
    server_seed="paste_revealed_server_seed_here",
    client_seed="your_client_seed",
    nonce=123,   # the bet number you want to check
    mines=3,
))