#!/bin/bash -f

# Offloads local files to S3, then deletes them locally.
# Updates .s3download-ignore so they are not re-downloaded automatically.
# Generates a per-directory remote_files.md as a local reference.
#
# Usage: ./s3sync_offload.sh <path> [<path2> ...]

BUCKET="s3://tine-pc-backup"
DOWNLOAD_IGNORE=".s3download-ignore"
UPLOAD_IGNORE=".s3upload-ignore"

if [ $# -eq 0 ]; then
    echo "Usage: $0 <path> [<path2> ...]"
    exit 1
fi

# Safety trap: warn if interrupted before deletion completes
trap 'echo ""; echo "WARNING: Script interrupted. Verify S3 state before proceeding."; exit 1' INT TERM

for LOCAL_PATH in "$@"; do
    LOCAL_PATH="${LOCAL_PATH%/}"

    echo "=== Offloading: $LOCAL_PATH ==="

    # Validate path exists
    if [ ! -e "$LOCAL_PATH" ]; then
        echo "ERROR: Path does not exist: $LOCAL_PATH"
        continue
    fi

    # Upload to S3
    echo "Uploading to $BUCKET/$LOCAL_PATH ..."
    if ! aws s3 sync "$LOCAL_PATH" "$BUCKET/$LOCAL_PATH" --exclude "remote_files.md"; then
        echo "ERROR: Upload failed. Skipping deletion."
        continue
    fi

    # Collect unique directories containing files (for per-dir remote_files.md generation)
    DIRS=()
    while IFS= read -r dir; do
        DIRS+=("$dir")
    done < <(find "$LOCAL_PATH" -type f ! -name "remote_files.md" -printf '%h\n' | sort -u)

    # Per-file verification: check each local file exists in S3 before deleting
    echo "Verifying files in S3..."
    ALL_VERIFIED=true

    while IFS= read -r -d '' LOCAL_FILE; do
        S3_KEY="${LOCAL_FILE#./}"
        if ! aws s3 ls "$BUCKET/$S3_KEY" > /dev/null 2>&1; then
            echo "WARNING: Not found in S3: $S3_KEY"
            ALL_VERIFIED=false
        fi
    done < <(find "$LOCAL_PATH" -type f ! -name "remote_files.md" -print0)

    if [ "$ALL_VERIFIED" = false ]; then
        echo "ERROR: Some files could not be verified in S3. No local files deleted for $LOCAL_PATH."
        continue
    fi

    # Delete local files (preserve directories and any existing remote_files.md)
    echo "All files verified. Deleting local copies..."
    find "$LOCAL_PATH" -type f ! -name "remote_files.md" -delete

    # Generate a remote_files.md in each directory listing only that directory's files
    for DIR in "${DIRS[@]}"; do
        echo "Generating $DIR/remote_files.md ..."
        {
            echo "# Remote Files"
            echo ""
            echo "These files have been offloaded to S3 ($BUCKET) and are not stored locally."
            echo "Use \`./s3sync_download.sh --include \"$DIR/*\"\` to restore them."
            echo ""
            echo "| File | Size | Last Modified |"
            echo "|------|------|---------------|"
            aws s3 ls "$BUCKET/$DIR/" | while IFS= read -r s3line; do
                [ -z "$s3line" ] && continue
                # Skip subdirectory entries (lines starting with "PRE ")
                echo "$s3line" | grep -q "^[[:space:]]*PRE " && continue
                DATE=$(echo "$s3line" | awk '{print $1}')
                SIZE=$(echo "$s3line" | awk '{print $3}')
                FILE=$(echo "$s3line" | awk '{for(i=4;i<=NF;i++) printf "%s%s",(i>4?" ":""),$i; print ""}')
                echo "| $FILE | $SIZE | $DATE |"
            done
        } > "$DIR/remote_files.md"
    done

    # Append path to .s3download-ignore if not already present
    IGNORE_ENTRY="$LOCAL_PATH/"
    if [ ! -f "$DOWNLOAD_IGNORE" ]; then
        printf "# Offloaded paths - not re-downloaded automatically\n" > "$DOWNLOAD_IGNORE"
    fi
    if ! grep -qxF "$IGNORE_ENTRY" "$DOWNLOAD_IGNORE" 2>/dev/null; then
        echo "$IGNORE_ENTRY" >> "$DOWNLOAD_IGNORE"
        echo "Added '$IGNORE_ENTRY' to $DOWNLOAD_IGNORE"
    fi

    # Ensure .s3upload-ignore exists with remote_files.md excluded
    if [ ! -f "$UPLOAD_IGNORE" ]; then
        printf "# Paths excluded from upload\n*remote_files.md\n" > "$UPLOAD_IGNORE"
    elif ! grep -qxF "*remote_files.md" "$UPLOAD_IGNORE" 2>/dev/null; then
        echo "*remote_files.md" >> "$UPLOAD_IGNORE"
    fi

    echo "=== Done: $LOCAL_PATH ==="
    echo ""
done
