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
aws s3 sync s3://tine-pc-backup . $@
