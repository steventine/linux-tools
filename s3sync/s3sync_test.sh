#!/bin/bash -f
#NOTE: the '-f' disables expansion for params (and maybe other stuff I don't want...not sure) to allow * to be passed in

#This script will check to see if there are any files that are out of sync with the S3 cloud.
#If there are, the details of the files will be printed.
#If the file exists locally, the details of the cloud and local version will be printed

#The 'aws s3 sync --dryrun' cmd will print out the files that it thinks should be uploaded.  The response format is
#  (dryrun) upload: ./test.txt to s3://tine-pc-backup/test 1.txt
#
#In the ideal situation:
#  $3 = local_filename
#  $4 = "to"
#  $5 = cloud_filename
#However, 'aws s3 sync' doesn't support JSON output and some file names have spaces in them which messes up the field numbers!
#So, this awk will loop through the fields looking for the 'to' (which is the separator between the source and dest filenames) 
# and combine the fields into $3 and combine all the fields after 'to' into $5

# NOTE - This logic will fail if any of the filenames have the word 'to' alone with spaces in it...don't do that!


# Optional first arg: local path to sync (default: . for full backup root)
# Must not start with - to distinguish from flags
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
    LOCAL_PATH="${1%/}"
    shift
else
    LOCAL_PATH="."
fi
[ "$LOCAL_PATH" = "." ] && S3_PATH="s3://tine-pc-backup" || S3_PATH="s3://tine-pc-backup/$LOCAL_PATH"

# Build exclude arrays from ignore files
DOWNLOAD_EXCLUDES=()
if [ -f .s3download-ignore ]; then
    while IFS= read -r line; do
        [[ "$line" =~ ^# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        DOWNLOAD_EXCLUDES+=(--exclude "${line%/}/*")
    done < .s3download-ignore
fi

UPLOAD_EXCLUDES=()
if [ -f .s3upload-ignore ]; then
    while IFS= read -r line; do
        [[ "$line" =~ ^# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        UPLOAD_EXCLUDES+=(--exclude "$line")
    done < .s3upload-ignore
fi

####### DOWNLOAD CHECK ########
#This will check for differences and print out the file details locally and in the cloud
echo "-------Download Check---------"
aws s3 sync "$S3_PATH" "$LOCAL_PATH" --dryrun "${DOWNLOAD_EXCLUDES[@]}" |awk '{\
	#Combine all source filename fields into $3
	for(i=4; i<=NF; i++) 
		{if($i=="to") break; else {$3=$3" "$i}};

	#Combine all cloud filename fields into $5
	i=i+1;$5=$i;
	for(i=i+1;i<=NF;i++)
	  $5=$5" "$i;

	printf("\n"); print $0;

	#Print out the details of the files in both places
	printf("LOCAL: "); system("find \"" $5 "\" -printf \"%AY-%Am-%Ad %AH:%AM:%.2AS\t %s %f\n\" ");
       	printf("CLOUD: "); system("aws s3 ls \"" $3 "\""); print ""}'

####### UPLOAD CHECK ########
#This will check for differences and print out the file details locally and in the cloud
echo
echo "-------Upload Check---------"
aws s3 sync "$LOCAL_PATH" "$S3_PATH" --dryrun "${UPLOAD_EXCLUDES[@]}" |awk '{\
	#Combine all source filename fields into $3
	for(i=4; i<=NF; i++) 
		{if($i=="to") break; else {$3=$3" "$i}};

	#Combine all cloud filename fields into $5
	i=i+1;$5=$i;
	for(i=i+1;i<=NF;i++)
	  $5=$5" "$i;

	printf("\n"); print $0;

	#Print out the details of the files in both places
	printf("LOCAL: "); system("find \"" $3 "\" -printf \"%AY-%Am-%Ad %AH:%AM:%.2AS\t %s %f\n\" ");
       	printf("CLOUD: "); system("aws s3 ls \"" $5 "\""); print ""}'
echo
echo
echo "If local files are newer, use the ./s3sync_upload.sh script"
echo "If the cloud files are newer, use the ./s3sync_download.sh script"
echo "You can also use the --exclude \"*\" --include \"filea.txt\" option for either command to limit it to a single file"

#OLD S3 COMMANDS KEPT AROUND JUST IN CASE THE NEW LOGIC ABOVE TO HANDLE SPACES IN FILESNAMES FAILS
#Download
#aws s3 sync s3://tine-pc-backup . --dryrun |awk '{ printf("\n"); print $0; printf("LOCAL: "); system("find " $5 " -printf \"%AY-%Am-%Ad %AH:%AM:%AS %s %f\n\" "); printf("CLOUD: "); system("aws s3 ls " $3) }'
#Upload
#aws s3 sync . s3://tine-pc-backup --dryrun |awk '{for(i=4; i<=NF; i++) {if($i=="to") break; else {$3=$3" "$i}};i=i+1;$5=$i;for(i=i+1;i<=NF;i++) $5=$5" "$i; printf("\n"); print $0; printf("LOCAL: "); system("find \"" $3 "\" -printf \"%AY-%Am-%Ad %AH:%AM:%.2AS\t %s %f\n\" "); printf("CLOUD: "); system("aws s3 ls \"" $5 "\""); print ""}'
#aws s3 sync . s3://tine-pc-backup --dryrun |awk '{ printf("\n"); print $0; printf("LOCAL: "); system("find " $3 " -printf \"%AY-%Am-%Ad %AH:%AM:%AS %s %f\n\" "); printf("CLOUD: "); system("aws s3 ls " $5) }'

