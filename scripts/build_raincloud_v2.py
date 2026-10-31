"""Drizzle (raincloud) sprite sheet v2.

Changes from v1:
  - 4-frame loops for every pose (was 2), with real motion: falling drops, drifting fog,
    orbiting dizzy dashes, flickering lightning, rotating rainbow bands, 2 px breathing bob.
  - New poses: move (float, drawn facing RIGHT), idle_side (resting, facing right),
    turn (5-frame squash-flip), look (glance right then left), blink (idle with eyes shut).
  - Facing convention: everything directional is drawn facing RIGHT. Facing left = mirror at runtime.
    Build-time flips use x -> 16 - x so the silhouette stays in the same columns as the runtime
    mirror (which the player corrects with a +1 px offset).
"""
import json, math
from PIL import Image, ImageDraw

W = H = 16
COLS = 6  # widest pose (look) has 6 frames
PAL = {
    'o': '#17323a', 'k': '#17323a', 'w': '#ffffff',
    'a': '#e1e9ef', 'c': '#b4c2cf', 'l': '#c6d2dc',
    'p': '#f1f5f8', 'q2': '#d7e0e7',
    'u': '#4fa8f0', 'y': '#ffcf4a', 'n': '#6b5bd6', 'z': '#6b5bd6',
    'm': '#f3e9b5', 'gr': '#b9c4cd', 'gs': '#97a5b1', 'ia': '#d3e8f6', 'is': '#a9cfe8', 'ic': '#6fb2e8',
    'e': '#9fb4c0', 'g': '#5b88a8', 'q': '#8ec9f5', 'r': '#e5484d', 'x': '#4caf6a',
}

def blank(): return [[None] * W for _ in range(H)]
def put(g, x, y, c):
    x = int(round(x)); y = int(round(y))
    if 0 <= x < W and 0 <= y < H: g[y][x] = c
def pl(g, pts, c):
    for x, y in pts: put(g, x, y, c)
def ell(g, cx, cy, rx, ry, c):
    for y in range(H):
        for x in range(W):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1: g[y][x] = c
def rect(g, x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1): put(g, x, y, c)
def outline(g):
    add = []
    for y in range(H):
        for x in range(W):
            if g[y][x]: continue
            if (x > 0 and g[y][x-1]) or (x < W-1 and g[y][x+1]) or (y > 0 and g[y-1][x]) or (y < H-1 and g[y+1][x]):
                add.append((x, y))
    for x, y in add: g[y][x] = 'o'
def outline_cells(g, cells):
    s = set(cells); add = []
    for x, y in cells:
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and g[ny][nx] is None and (nx, ny) not in s: add.append((nx, ny))
    for x, y in add: g[y][x] = 'o'
def flip16(g):
    """Mirror about x=8 so the cloud (cols 1..15) keeps its columns. Col 0 falls off, by design."""
    out = blank()
    for y in range(H):
        for x in range(W):
            if g[y][x]:
                nx = 16 - x
                if 0 <= nx < W: out[y][nx] = g[y][x]
    return out

def cloud(g, oy=0, pale=False, skin=None, dx=0, sx=1.0):
    a, sh = ('p', 'q2') if pale else ('a', 'c')
    if skin == 'gray': a, sh = 'gr', 'gs'
    if skin == 'ice': a, sh = 'ia', 'is'
    X = lambda cx: 8 + (cx - 8) * sx + dx
    ell(g, X(5), 7 + oy, 3.2 * sx, 2.6, a)
    ell(g, X(9.5), 6 + oy, 3.8 * sx, 3.2, a)
    ell(g, X(12), 8 + oy, 2.6 * sx, 2.2, a)
    rect(g, int(round(X(4))), 8 + oy, int(round(X(12))), 9 + oy, a)
    outline(g)
    for y in range(H):
        for x in range(W):
            if g[y][x] == a and y >= 9 + oy: g[y][x] = sh

EYES = {
    'none':  [],
    'half':  [(5,6,'l'),(6,6,'l'),(9,6,'l'),(10,6,'l'),(5,7,'k'),(6,7,'k'),(9,7,'k'),(10,7,'k')],
    'dash':  [(5,7,'k'),(6,7,'k'),(9,7,'k'),(10,7,'k')],
    'sleep': [(4,7,'k'),(5,8,'k'),(6,7,'k'),(9,7,'k'),(10,8,'k'),(11,7,'k')],
    'happy': [(5,6,'k'),(4,7,'k'),(6,7,'k'),(10,6,'k'),(9,7,'k'),(11,7,'k')],
    'wide':  [(5,6,'w'),(6,6,'k'),(5,7,'k'),(6,7,'k'),(9,6,'w'),(10,6,'k'),(9,7,'k'),(10,7,'k')],
    'spiral':[(4,6,'k'),(6,6,'k'),(5,7,'k'),(4,8,'k'),(6,8,'k'),
              (9,6,'k'),(11,6,'k'),(10,7,'k'),(9,8,'k'),(11,8,'k')],
}
MOUTH = {
    'flat':  [(7,9),(8,9)],
    'smile': [(6,8),(7,9),(8,9),(9,8)],
    'frown': [(6,9),(7,8),(8,8),(9,9)],
    'o':     [(7,8),(8,8),(7,9),(8,9)],
}
def face(g, oy, eyes, mouth, dx=0):
    for x, y, c in EYES[eyes]: put(g, x + dx, y + oy, c)
    for x, y in MOUTH[mouth]: put(g, x + dx, y + oy, 'k')

B2 = [0, 1, 2, 1]   # 2 px breathing bob, smooth triangle
B1 = [0, 1, 1, 0]   # 1 px bob for poses with props underneath

SUNB = [(1,1),(2,1),(3,1),(1,2),(2,2),(3,2),(1,3),(2,3),(3,3)]
R_PLUS = [(2,0),(0,2),(4,2),(2,4)]
R_X = [(0,0),(4,0),(0,4),(4,4)]
RAYS = [R_PLUS, R_PLUS + R_X, R_X, R_PLUS + R_X]
BOLT_A = [(9,12),(8,12),(8,13),(7,13),(7,14),(6,15),(7,15)]
BOLT_B = [(x + 4, y) for x, y in BOLT_A]
NOTE = [(14,0),(14,1),(14,2),(14,3),(13,3),(15,0),(15,1)]
Z_BIG = [(12,0),(13,0),(14,0),(15,0),(14,1),(13,2),(12,3),(13,3),(14,3),(15,3)]
Z_SM = [(13,1),(14,1),(15,1),(14,2),(13,3),(14,3),(15,3)]

def drops(g, cols, f, color='u', y0=12, n=4):
    for x, ph in cols:
        put(g, x, y0 + ((f + ph) % n), color)

def sun(g, rays):
    pl(g, SUNB + rays, 'y')

def pose(name, f):
    g = blank()
    if name == 'idle':
        oy = B2[f]; cloud(g, oy); face(g, oy, 'half', 'flat')
    elif name == 'blink':   # same bob as idle, eyes shut; player swaps this row in for a few ms
        oy = B2[f]; cloud(g, oy); face(g, oy, 'dash', 'flat')
    elif name == 'idle_side':   # resting, facing RIGHT
        oy = B2[f]; cloud(g, oy); face(g, oy, 'half', 'flat', dx=2)
    elif name == 'move':        # floating, facing RIGHT, with speed ticks behind
        oy = B2[f]; cloud(g, oy); face(g, oy, 'half', 'flat', dx=2)
        ticks = [[(0,7),(0,10)], [(0,8),(0,11)], [(0,9),(0,12)], [(0,8),(0,11)]][f]
        pl(g, ticks, 'e')
    elif name == 'look':        # glance right, back to center, glance left, hold
        dx = [0, 2, 2, 0, -1, -1][f]   # +2 / -1 are mirror-symmetric about the cloud centre
        cloud(g, 0); face(g, 0, 'half', 'flat', dx=dx)
    elif name == 'turn':        # left-facing -> squash -> right-facing (play reversed for R to L)
        base = blank(); cloud(base, 0); face(base, 0, 'half', 'flat', dx=2)       # facing right
        if f == 4: return base
        if f == 0: return flip16(base)
        if f in (1, 3):
            t = blank(); cloud(t, 0, sx=0.78); face(t, 0, 'half', 'flat', dx=-1)  # facing left, narrower
            return t if f == 1 else flip16(t)
        t = blank(); cloud(t, 0, sx=0.62)                                          # edge on
        put(t, 7, 6, 'l'); put(t, 7, 7, 'k'); put(t, 9, 6, 'l'); put(t, 9, 7, 'k'); pl(t, [(8,9)], 'k')
        return t
    elif name == 'drizzle':
        oy = B1[f]; cloud(g, oy); face(g, oy, 'half', 'frown')
        drops(g, [(4,0),(7,2),(10,1),(12,3)], f)
    elif name == 'sunbreak':
        oy = B1[f]; sun(g, RAYS[f]); cloud(g, oy); face(g, oy, 'happy', 'smile')
        outline_cells(g, SUNB + RAYS[f])
    elif name == 'storm':
        dx = [0, -1, 0, -1][f]
        cloud(g, 0, dx=dx); face(g, 0, 'wide', 'o', dx=dx)
        bolt = [BOLT_A, [], BOLT_B, []][f]
        pl(g, bolt, 'y'); outline_cells(g, bolt)
    elif name == 'sleepy':
        oy = B2[f]; cloud(g, oy); face(g, oy, 'sleep', 'flat')
        if f in (1, 2): pl(g, Z_BIG, 'z')
        elif f == 3: pl(g, Z_SM, 'z')
    elif name == 'dizzy':
        oy = B1[f]; cloud(g, oy); face(g, oy, 'spiral', 'flat')
        ly = [3, 4, 5, 4][f]; ry = [5, 4, 3, 4][f]
        pl(g, [(0,ly),(1,ly),(14,ry),(15,ry)], 'e')
    elif name == 'music':
        oy = B1[f]; cloud(g, oy); face(g, oy, 'sleep', 'flat')
        pl(g, [(x, y + [0, 1, 1, 0][f]) for x, y in NOTE], 'n')
    elif name == 'focus':
        cloud(g, 0); face(g, 0, 'dash', 'flat')
        s = [0, 1, 2, 1][f]
        pl(g, [(0,6+s),(1,6+s),(0,8+s),(14,5+s),(15,5+s),(15,7+s)], 'e')
    elif name == 'water':
        cloud(g, 0); face(g, 0, 'half', 'flat')
        pl(g, [(6,12),(9,12),(6,13),(9,13),(6,14),(9,14),(6,15),(7,15),(8,15),(9,15)], 'g')
        pl(g, [(7,14),(8,14)], 'q')
        if f < 3: put(g, 8, 11 + f, 'u')
        else: pl(g, [(7,13),(8,13)], 'q')
    elif name == 'fade':
        oy = B2[f]; cloud(g, oy, pale=True); face(g, oy, 'sleep', 'flat')
    elif name == 'hello':
        cols = ['r', 'y', 'u', 'y']
        for y in range(0, 4):
            for x in range(0, 8):
                r = math.hypot(x - 3, y - 5)
                band = 0 if 3.5 <= r < 4.5 else 1 if 2.5 <= r < 3.5 else 2 if 1.5 <= r < 2.5 else None
                if band is not None: g[y][x] = cols[(band + f) % 4]
        oy = B1[f]; cloud(g, oy); face(g, oy, 'half', 'smile')
    elif name == 'wx_clear_day':
        oy = B1[f]; sun(g, RAYS[f]); cloud(g, oy); face(g, oy, 'none', 'flat')
        rect(g, 4, 6 + oy, 6, 7 + oy, 'k'); rect(g, 9, 6 + oy, 11, 7 + oy, 'k'); pl(g, [(7,6+oy),(8,6+oy)], 'k')
        pl(g, [(4,6+oy),(9,6+oy)], 'w')
        outline_cells(g, SUNB + RAYS[f])
    elif name == 'wx_clear_night':
        oy = B1[f]
        moon = [(1,1),(2,1),(1,2),(1,3),(2,3),(3,3),(2,2)]
        pl(g, moon, 'm'); cloud(g, oy); face(g, oy, 'half', 'flat')
        sets = [[(6,0),(13,1),(15,3)], [(7,1),(12,0),(14,3)], [(8,0),(13,2),(15,4)]]
        pl(g, sets[[0, 1, 2, 1][f]], 'y'); outline_cells(g, moon)
    elif name == 'wx_partly':
        oy = B1[f]; rays = [[], R_PLUS, R_X, R_PLUS][f]
        sun(g, rays); cloud(g, oy); face(g, oy, 'half', 'flat')
        outline_cells(g, SUNB + rays)
    elif name == 'wx_overcast':
        oy = B2[f]; cloud(g, oy, skin='gray'); face(g, oy, 'half', 'frown')
    elif name == 'wx_fog':
        oy = B1[f]; cloud(g, oy, pale=True); face(g, oy, 'dash', 'flat')
        for yy in (1, 12, 14):
            for x in range(1, 15):
                if (x + f + yy) % 4 != 3: put(g, x, yy, 'e')
    elif name == 'wx_drizzle':
        oy = B1[f]; cloud(g, oy); face(g, oy, 'half', 'flat')
        drops(g, [(5,0),(10,2)], f)
    elif name == 'wx_rain':
        oy = B1[f]; cloud(g, oy); face(g, oy, 'half', 'frown')
        drops(g, [(3,0),(6,2),(8,1),(11,3),(13,0)], f)
    elif name == 'wx_snow':
        oy = B1[f]; cloud(g, oy, skin='ice'); face(g, oy, 'half', 'flat')
        for x0, ph in [(4,0),(8,2),(12,1)]:
            k = (f + ph) % 4
            put(g, x0 + [0, 1, 0, -1][k], 12 + k, 'ic')
    elif name == 'wx_thunder':
        cloud(g, 0, skin='gray'); face(g, 0, 'half', 'frown')
        bolt = [BOLT_A, [], BOLT_B, []][f]
        pl(g, bolt, 'y'); outline_cells(g, bolt)
    elif name == 'wx_windy':
        oy = B1[f]; cloud(g, oy); face(g, oy, 'half', 'o')
        A = [(0,3),(1,3),(2,3),(13,5),(14,5),(15,5),(0,9),(1,9),(14,10),(15,10)]
        Bs = [(0,4),(1,4),(14,3),(15,3),(0,10),(1,10),(2,10),(13,9),(14,9),(15,9)]
        pl(g, [A, [(x + 1, y) for x, y in A], Bs, [(x - 1, y) for x, y in Bs]][f], 'e')
    elif name == 'wx_hot':
        oy = B1[f]; sun(g, RAYS[f]); cloud(g, oy); face(g, oy, 'half', 'frown')
        pl(g, [[(15,4),(14,5),(15,5),(15,6)], [(15,5),(14,6),(15,6),(15,7)]][f % 2], 'u')
        outline_cells(g, SUNB + RAYS[f])
    elif name == 'wx_cold':
        dx = [0, -1, 0, -1][f]
        cloud(g, 0, skin='ice', dx=dx); face(g, 0, 'dash', 'flat', dx=dx)
        scarf = [(x + dx, 10) for x in range(4, 11)] + [(8+dx,11),(9+dx,11),(8+dx,12),(9+dx,12)]
        pl(g, scarf, 'r'); outline_cells(g, scarf)
        pl(g, [(0,6),(0,8),(15,6),(15,8)] if f % 2 == 0 else [(0,7),(0,9),(15,7),(15,9)], 'e')
    return g

# name -> (frames, fps, loop)
POSES = [
    ('idle', 4, 4, True), ('drizzle', 4, 5, True), ('sunbreak', 4, 4, True), ('storm', 4, 8, True),
    ('sleepy', 4, 2.5, True), ('dizzy', 4, 6, True), ('music', 4, 5, True), ('focus', 4, 6, True),
    ('water', 4, 4, True), ('fade', 4, 2, True), ('hello', 4, 5, True),
    ('wx_clear_day', 4, 4, True), ('wx_clear_night', 4, 3, True), ('wx_partly', 4, 4, True),
    ('wx_overcast', 4, 2, True), ('wx_fog', 4, 3, True), ('wx_drizzle', 4, 5, True), ('wx_rain', 4, 8, True),
    ('wx_snow', 4, 4, True), ('wx_thunder', 4, 8, True), ('wx_windy', 4, 6, True), ('wx_hot', 4, 4, True),
    ('wx_cold', 4, 8, True),
    ('idle_side', 4, 4, True), ('move', 4, 8, True), ('blink', 4, 4, True),
    ('turn', 5, 22, False), ('look', 6, 4, False),
]

def render(g):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); px = im.load()
    for y in range(H):
        for x in range(W):
            c = g[y][x]
            if c:
                h = PAL[c].lstrip('#'); px[x, y] = tuple(int(h[i:i+2], 16) for i in (0, 2, 4)) + (255,)
    return im

sheet = Image.new('RGBA', (W * COLS, H * len(POSES)), (0, 0, 0, 0))
for r, (name, n, fps, loop) in enumerate(POSES):
    for f in range(n):
        sheet.paste(render(pose(name, f)), (f * W, r * H))
sheet.save('raincloud_v2.png')
sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST).save('raincloud_v2@4x.png')

# labeled preview
S = 5; pad = 8; lab = 100
prev = Image.new('RGB', (lab + COLS * (W * S + pad) + pad, len(POSES) * (H * S + pad) + pad), '#e6edec')
d = ImageDraw.Draw(prev)
for r, (name, n, fps, loop) in enumerate(POSES):
    y0 = pad + r * (H * S + pad)
    d.text((pad, y0 + H * S // 2 - 5), name, fill='#14282b')
    for f in range(n):
        cell = sheet.crop((f * W, r * H, f * W + W, r * H + H)).resize((W * S, H * S), Image.NEAREST)
        bg = Image.new('RGBA', cell.size, '#f6f9f8'); bg.alpha_composite(cell)
        prev.paste(bg.convert('RGB'), (lab + pad + f * (W * S + pad), y0))
prev.save('preview_v2.png')

manifest = {
    'version': 2,
    'frameSize': 16,
    'frameCount': 4,                      # default frames per pose; per-pose "frames" overrides it
    'image': 'raincloud_v2.png',
    'imageScale4x': 'raincloud_v2@4x.png',
    'columns': COLS,
    'poses': {n: {'row': i, 'frames': fr, 'fps': fps, 'loop': lp} for i, (n, fr, fps, lp) in enumerate(POSES)},
    'defaultPose': 'idle',
    'facing': {
        'native': 'right',                # directional poses are drawn facing right
        'directionalPoses': ['move', 'idle_side'],
        'mirrorOffsetPx': 1,              # add this many sprite pixels when drawing mirrored
        'turnPose': 'turn',               # frames run left-facing to right-facing; play reversed for R to L
        'restPose': 'idle_side',
        'movePose': 'move',
    },
    'blink': {'basePose': 'idle', 'blinkPose': 'blink', 'durationMs': 140, 'minGapMs': 2800, 'maxGapMs': 6500},
    'glance': {'pose': 'look', 'minGapMs': 7000, 'maxGapMs': 14000},
    'ambientReactions': ['short_idle', 'music_paused', 'video_watching', 'game_time', 'chat_chatter', 'idle'],
    'reactions': {
        'welcome_back': 'hello', 'greeting': 'hello', 'returned_from_idle': 'hello',
        'celebrate': 'sunbreak',
        'stuck': 'drizzle',
        'error_spotted': 'storm',
        'late_night': 'sleepy', 'goodnight': 'sleepy',
        'fast_context_switching': 'dizzy',
        'music_vibe': 'music', 'new_song': 'music',
        'fast_typing': 'focus', 'focused': 'focus', 'deep_work_streak': 'focus',
        'hydrate_nudge': 'water', 'break_suggestion': 'water', 'lunch_break': 'water',
        'long_idle': 'fade',
        'short_idle': 'idle', 'music_paused': 'idle', 'video_watching': 'idle', 'game_time': 'idle', 'chat_chatter': 'idle',
    },
}
json.dump(manifest, open('raincloud_v2.json', 'w'), indent=2)
print('ok', sheet.size, len(POSES), 'poses')
