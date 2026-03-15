#!/bin/bash -f
#NOTE: the '-f' disables expansion for params to allow * to be passed in

# Lists all delete markers in the S3 bucket.
# Delete markers are created when a versioned object is deleted.

BUCKET="tine-pc-backup"

# Optional first arg: key prefix to filter by (e.g. "Videos/")
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
    PREFIX_ARG="--prefix $1"
    echo "Delete markers under: $1"
else
    PREFIX_ARG=""
    echo "All delete markers in s3://$BUCKET"
fi

echo

printf "%-30s  %-60s  %s\n" "DELETED (local time)" "KEY" "VERSION ID"
printf "%-30s  %-60s  %s\n" "$(printf '%0.s-' {1..30})" "$(printf '%0.s-' {1..60})" "$(printf '%0.s-' {1..36})"

aws s3api list-object-versions \
    --bucket "$BUCKET" \
    $PREFIX_ARG \
    --query "DeleteMarkers[?IsLatest==\`true\`].[LastModified,Key,VersionId]" \
    --output text | while IFS=$'\t' read -r utc_date key version; do
    local_date=$(date -d "$utc_date" 2>/dev/null)
    printf "%-30s  %-60s  %s\n" "$local_date" "$key" "$version"
done
