#!/bin/bash
# RoadPush 를 moo1024/roadpush 공개 저장소에 올리고 GitHub Pages 를 켠다
set -e
cd /home/lmh/roadpush-site
gh repo create moo1024/roadpush --public --source=. --push
gh api -X POST repos/moo1024/roadpush/pages -f "source[branch]=main" -f "source[path]=/" --jq '.html_url'
