#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-icons.py — 把「圆角 + 四角白边」的成品图标处理成 full-bleed（四角不留白）的方形 PNG。

为什么需要它：iOS 主屏自己会给图标加圆角。若把一张「已经圆角、四角是白」的图直接当 apple-touch-icon，
主屏上就会变成「白色方块里套一个圆角图」——二次圆角 + 白边。所以要把四角补满。

做法（不裁掉任何内容，人物与底部「成都地铁 / CHENGDU METRO」完整保留）：
  * 逐行从左/右找第一个「真正的底色蓝」（`solid_blue`：r<95 且 b>165 且 b-r>115）的位置 stop，
    把 [0, stop)（左侧）或 (stop, W-1]（右侧）用**该行镜像过来**的颜色补齐；
  * 用镜像而不是取单个颜色：源像素总在形状内侧，天然避开圆角边缘那圈抗锯齿的浅蓝，
    也能自然延续底色的细微渐变（取边缘像素会让补出来的一圈发白）；
  * 单行白段占比 > 55% 的行不处理，避免把「本来该白的设计元素」误涂。
  圆角方形内部（脸、logo 的白色飘带、文字）一个像素都不动。

用法：
  python3 tools/make-icons.py [源图] [输出目录]
默认源图 `/mnt/c/Users/Nero/Downloads/icon.jpg`（1254×1254 的圆角成品图），
输出 `icon-180.png` / `icon-512.png` / `icon-32.png`（覆盖仓库里的同名文件，index.html 与 manifest.json 无需改动）。
"""
import os
import sys

from PIL import Image

WHITE_T = 250      # 判定“白边”的阈值（放宽一点，把抗锯齿的灰白边一起吃掉）
EDGE = 60.0        # 单行白段占比上限（%）


def near_white(p):
    return p[0] >= WHITE_T and p[1] >= WHITE_T and p[2] >= WHITE_T


def solid_blue(p):
    r, g, b = p[0], p[1], p[2]
    return r < 95 and b > 165 and (b - r) > 115


def make_full_bleed(src):
    im = Image.open(src).convert('RGB')
    W, H = im.size
    px = im.load()
    filled = 0
    for y in range(H):
        row = [px[x, y] for x in range(W)]
        nw = sum(1 for p in row if near_white(p))
        if nw / float(W) > EDGE / 100.0:
            continue
        for side in (0, 1):
            stop = None
            rng = range(W) if side == 0 else range(W - 1, -1, -1)
            for x in rng:
                if solid_blue(row[x]):
                    stop = x
                    break
            if stop is None or (side == 0 and stop == 0) or (side == 1 and stop == W - 1):
                continue
            tail = list(range(stop)) if side == 0 else list(range(stop + 1, W))
            if len(tail) > W * 0.55:
                continue
            for x in tail:
                sx = 2 * stop - x
                sx = 0 if sx < 0 else (W - 1 if sx >= W else sx)
                px[x, y] = row[sx]
                filled += 1
    print('  full-bleed 补了 %d 像素（四角）' % filled)
    return im


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else '/mnt/c/Users/Nero/Downloads/icon.jpg'
    outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__)) + '/..'
    if not os.path.exists(src):
        print('! 源图不存在：%s' % src, file=sys.stderr)
        return 1
    im = make_full_bleed(src)
    for size, name in ((180, 'icon-180.png'), (512, 'icon-512.png'), (32, 'icon-32.png')):
        p = os.path.join(outdir, name)
        im.resize((size, size), Image.LANCZOS).save(p, optimize=True)
        print('  写入 %s（%dx%d，%d B）' % (p, size, size, os.path.getsize(p)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
