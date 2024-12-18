#!/bin/bash

cd "$(dirname "$0")" || exit
cd ..

RED="\e[31;1m"
YELLOW="\e[33;1m"
GREEN="\e[32;1m"
ENDCOLOR="\e[0m"

if [[ "$1" == "-r" ]]; then
    echo -e "$RED* Cleaning up the instrument *$ENDCOLOR"
    rm -f build/wallet_v5*.fif
fi

if [ ! -f build/wallet_v5.fif ]; then
    mkdir -p build
    echo -e "$YELLOW* Creating comparation origin *$ENDCOLOR"
    echo "Use scalpel.sh -r to clean the instrument after commiting"
    func contracts/imports/stdlib.fc contracts/wallet_v5.fc > build/wallet_v5.fif
    func -SR contracts/imports/stdlib.fc contracts/wallet_v5.fc >build/wallet_v5_x.fif 2>&1
fi

declare -A mlen
declare -A mlen_new

func contracts/imports/stdlib.fc contracts/wallet_v5.fc > build/wallet_v5_vs.fif
func -SR contracts/imports/stdlib.fc contracts/wallet_v5.fc >build/wallet_v5_vs_x.fif 2>&1

KEY=""
CNT=0
while IFS= read -r line
do
    if [[ "$line" =~ ^"//" ]]; then continue; fi
    if [[ "$line" =~ ^"DECLPROC" ]]; then continue; fi
    if [[ "$line" =~ ^[0-9]+" DECLMETHOD" ]]; then continue; fi
    if ! [[ "$line" =~ ^" " ]]; then
        if [[ "$line" == "}>" ]]; then
            mlen["$KEY"]="$CNT"
        else
            CNT=0
            KEY="$line"
        fi
    else
        CNT=$((CNT+1))
    fi
done < build/wallet_v5.fif

KEY=""
CNT=0
while IFS= read -r line
do
    if [[ "$line" =~ ^"//" ]]; then continue; fi
    if [[ "$line" =~ ^"DECLPROC" ]]; then continue; fi
    if [[ "$line" =~ ^[0-9]+" DECLMETHOD" ]]; then continue; fi
    if ! [[ "$line" =~ ^" " ]]; then
        if [[ "$line" == "}>" ]]; then
            mlen_new["$KEY"]="$CNT"
        else
            CNT=0
            KEY="$line"
        fi
    else
        CNT=$((CNT+1))
    fi
done < build/wallet_v5_vs.fif

diff -C 5 build/wallet_v5.fif build/wallet_v5_vs.fif

LINES=$(grep -v -e '^//' -e '^DECLPROC'  -e '^[0-9]\+ DECLMETHOD' build/wallet_v5.fif | wc -l)
NLINES=$(grep -v -e '^//' -e '^DECLPROC'  -e '^[0-9]\+ DECLMETHOD' build/wallet_v5_vs.fif | wc -l)
echo ""
echo -e "${YELLOW}Lines: $LINES -> $NLINES$ENDCOLOR"
for key in "${!mlen_new[@]}"
do
    PFX=""
    if [ "${mlen_new[$key]}" -gt "${mlen[$key]}" ]; then
        PFX=$RED
    fi
    if [ "${mlen_new[$key]}" -lt "${mlen[$key]}" ]; then
        PFX=$GREEN
    fi
    echo -e "$PFX${mlen[$key]} -> ${mlen_new[$key]} | $key$ENDCOLOR";
done
echo ""
