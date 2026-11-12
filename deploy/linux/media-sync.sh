#!/bin/bash
# 把 videodownload 下载的内容硬链进 Jellyfin 媒体库（硬链，不占额外空间）
#
# 站点名由服务端 util.siteKey 归一：missav.ai/.ws → missav，douyin.com → 抖音
#
# 两类站点，两种归置方式：
#   A) 独立库站点（missav / hanime1 / 抖音）：整个目录原样镜像到 /srv/share/media/<站点>/
#      → Jellyfin 里按「电影」类型加库即可（散文件、按集数命名的文件都能看到）
#   B) 其它站点：
#        <站点>/<剧名>/Season 01/xxx.mp4  -> 电视剧/<剧名>/Season 01/   （走「节目」库，有季/集）
#        <站点>/<散文件>.mp4              -> /srv/share/media/<站点>/
#
# 幂等：重复跑只补新链接，不覆盖已有文件。
set -u
SRC=${SRC:-/home/xielaoban/videodownload-deploy/downloads}
MEDIA=${MEDIA:-/srv/share/media}
SITE_LIBS="missav hanime1 抖音"
shopt -s nullglob

link_file() { # $1=源文件 $2=目标目录
  local f=$1 dest=$2 base
  base=$(basename "$f")
  mkdir -p "$dest" 2>/dev/null || return 0
  [ -e "$dest/$base" ] || ln "$f" "$dest/$base" 2>/dev/null || cp -n "$f" "$dest/$base" 2>/dev/null
}

mirror() { # $1=源目录 $2=目标目录（递归硬链，只认视频扩展名）
  local src=$1 dst=$2 f base
  mkdir -p "$dst" 2>/dev/null || return 0
  for f in "$src"/*; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    if [ -d "$f" ]; then
      mirror "$f" "$dst/$base"
    else
      case "$base" in
        *.mp4|*.mkv|*.webm|*.ts) link_file "$f" "$dst" ;;
      esac
    fi
  done
}

is_site_lib() {
  local s
  for s in $SITE_LIBS; do [ "$s" = "$1" ] && return 0; done
  return 1
}

for site_dir in "$SRC"/*/; do
  site=$(basename "$site_dir")
  case "$site" in .wvd-tmp|.tmp-upload|.*) continue ;; esac

  if is_site_lib "$site"; then
    mirror "$site_dir" "$MEDIA/$site"
    continue
  fi

  for item in "$site_dir"/*; do
    name=$(basename "$item")
    if [ -d "$item" ]; then
      for season_dir in "$item"/*/; do
        season=$(basename "$season_dir")
        case "$season" in Season*|S[0-9]*) ;; *) continue ;; esac
        dest="$MEDIA/电视剧/$name/$season"
        for f in "$season_dir"*.mp4 "$season_dir"*.mkv "$season_dir"*.webm "$season_dir"*.ts; do
          [ -f "$f" ] || continue
          link_file "$f" "$dest"
        done
      done
    else
      case "$name" in
        *.mp4|*.mkv|*.webm|*.ts) link_file "$item" "$MEDIA/$site" ;;
      esac
    fi
  done
done

# Jellyfin 以 jellyfin 用户运行，需要可读
chmod -R o+rX "$MEDIA" 2>/dev/null || true
exit 0
