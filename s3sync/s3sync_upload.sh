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
echo "Add --delete to the end of this command to also remove files from S3 that were removed locally"
aws s3 sync . s3://tine-pc-backup $@
