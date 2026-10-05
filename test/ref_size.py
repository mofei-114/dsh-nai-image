"""参考实现的尺寸收敛逻辑（照抄 main.py:1591-1627），用于差分对比。

输入/输出都走文件，避免命令行引号与管道捕获问题。
"""
import json
import re
import sys

_OPENAI_MAX_SIDE = 1920
_OPENAI_MAX_AREA = 3686400

_OPENAI_SIZE_MAP = {
    "方图": "1024x1024", "竖图": "832x1216", "横图": "1216x832",
    "2K方图": "1472x1472", "2K竖图": "1088x1920", "2K横图": "1920x1088",
    "4K方图": "1472x1472", "4K竖图": "1088x1920", "4K横图": "1920x1088",
}


def normalize(size: str) -> str:
    match = re.match(r"^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$", str(size), re.IGNORECASE)
    if not match:
        return "1024x1024"
    width = max(64, (int(match.group(1)) + 32) // 64 * 64)
    height = max(64, (int(match.group(2)) + 32) // 64 * 64)
    while max(width, height) > _OPENAI_MAX_SIDE and min(width, height) > 64:
        if width >= height:
            width -= 64
        else:
            height -= 64
    while width * height > _OPENAI_MAX_AREA and min(width, height) > 64:
        if width >= height:
            width -= 64
        else:
            height -= 64
    return f"{width}x{height}"


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as fh:
        cases = json.load(fh)
    out = []
    for c in cases:
        mapped = _OPENAI_SIZE_MAP.get(c, c)
        out.append({"case": c, "mapped": mapped, "ref": normalize(mapped)})
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)


main()
