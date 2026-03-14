#!/bin/bash -f
#NOTE: The '-f' allows a * to be bassed as a param but might have other bad side effects

##### BE CAREFUL #####
# This script assumes that S3 is the source of truth and changes the local disk to match
######################

#Retrieves files from S3 and copies them to the local disk.
# Full options: https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html
# Useful options:
#   --exclude "*.mp4" 
#   --exclude "*" --include "*.mp4"
#   --delete  (to remove local files that were removed from the cloud)
echo "Add --delete to the end of this command to also remove local files that have been removed in S3"

EXCLUDES=()
if [ -f .s3download-ignore ]; then
    while IFS= read -r line; do
        [[ "$line" =~ ^# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        EXCLUDES+=(--exclude "${line%/}/*")
    done < .s3download-ignore
fi

# Run dryrun first to detect any files that would overwrite existing local files
DRYRUN_OUTPUT=$(aws s3 sync s3://tine-pc-backup . --dryrun "${EXCLUDES[@]}" $@)

if [ -z "$DRYRUN_OUTPUT" ]; then
    echo "Already up to date."
    exit 0
fi

OVERWRITES=()
while IFS= read -r line; do
    # Extract local path — everything after the last " to "
    LOCAL_FILE="${line##* to }"
    [ -f "$LOCAL_FILE" ] && OVERWRITES+=("$LOCAL_FILE")
done <<< "$DRYRUN_OUTPUT"

if [ ${#OVERWRITES[@]} -gt 0 ]; then
    echo ""
    echo "WARNING: The following local files already exist and would be overwritten:"
    for f in "${OVERWRITES[@]}"; do
        echo "  $f"
    done
    echo ""
    read -p "Continue with download? (y/N) " CONFIRM
    [[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

aws s3 sync s3://tine-pc-backup . "${EXCLUDES[@]}" $@
