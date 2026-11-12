#!/bin/bash
# 把 videodownload 下载的内容硬链进 Jellyfin 媒体库（硬链，不占额外空间）
#
# 目录约定（站点名由服务端 util.siteKey 归一：missav.ai/.ws → missav，douyin → 抖音）：
#   downloads/<站点>/<散文件>.mp4                 -> /srv/share/media/<站点>/<文件>
#       站点库：missav / hanime1 / 抖音 ……（Jellyfin 里按「电影 / 主页视频」类型添加）
#   downloads/<站点>/<剧名>/Season 01/<剧名> - S01E01.mp4
#                                                -> /srv/share/media/电视剧/<剧名>/Season 01/
#       剧集走 Jellyfin 的「节目」库，才会有季/集结构和下一集
#
# 幂等：重复跑只会补新建的链接，不会覆盖已有文件。
# 用法：/usr/local/bin/media-sync.sh
set -u
SRC=${SRC:-/home/xielaoban/videodownload-deploy/downloads}
MEDIA=${MEDIA:-/srv/share/media}
shopt -s nullglob

link_file() { # $1=源文件 $2=目标目录
  local f=$1 dest=$2 base
  base=$(basename "$f")
  mkdir -p "$dest" 2>/dev/null || return 0
  [ -e "$dest/$base" ] || ln "$f" "$dest/$base" 2>/dev/null || cp -n "$f" "$dest/$base" 2>/dev/null
}

for site_dir in "$SRC"/*/; do
  site=$(basename "$site_dir")
  case "$site" in .wvd-tmp|.tmp-upload|.*) continue ;; esac
  for item in "$site_dir"/*; do
    name=$(basename "$item")
    if [ -d "$item" ]; then
      # 剧集目录：<剧名>/Season XX/*.mp4
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
        *.mp4|*.mkv|*.webm|*.ts)
          link_file "$item" "$MEDIA/$site"
          ;;
      esac
    fi
  done
done

# Jellyfin 以 jellyfin 用户运行，需要可读
chmod -R o+rX "$MEDIA" 2>/dev/null || true
exit 0
