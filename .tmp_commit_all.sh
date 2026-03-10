cd /c/openclaw
mapfile -t files < <(git status --porcelain | sed -E "s/^.. //")
echo "Staging ${#files[@]} paths"
scripts/committer "feat: simplify memory sync and telegram queue flows" "${files[@]}"
