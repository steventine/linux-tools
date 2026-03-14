#!/bin/bash -f
#NOTE: The '-f' allows a * to be passsed as a param but might have other bad side effects

###### BE CAREFUL!!! ####
#  This scrip assumes the local disk is the master source of truth and changes S3 to match
#########################

#Syncs file from the local disk up to S3 storage
# Full options: https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html
# Useful options:
#   --exclude "*.mp4" 
#   --exclude "*" --include "*.sh"
#   --delete  (to remove files from S3 that were removed locally)
#   --dryrun
# Example: aws s3 sync . s3://tine-pc-backup --exclude "*" --include "s3sync_download.sh" --include "s3sync_upload.sh"
echo "Add --delete to the end of this command to also remove files from S3 that were removed locally"

# Optional first arg: local path to sync (default: . for full backup root)
# Must not start with - to distinguish from flags like --delete
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
    LOCAL_PATH="${1%/}"
    shift
else
    LOCAL_PATH="."
fi
[ "$LOCAL_PATH" = "." ] && S3_PATH="s3://tine-pc-backup" || S3_PATH="s3://tine-pc-backup/$LOCAL_PATH"

EXCLUDES=()
if [ -f .s3upload-ignore ]; then
    while IFS= read -r line; do
        [[ "$line" =~ ^# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        EXCLUDES+=(--exclude "$line")
    done < .s3upload-ignore
fi

aws s3 sync "$LOCAL_PATH" "$S3_PATH" "${EXCLUDES[@]}" $@
