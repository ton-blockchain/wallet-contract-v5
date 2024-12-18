#!/bin/bash

cd "$(dirname "$0")" || exit
cd ../fift || exit

jq -j ".hex" ../build/wallet_v5.compiled.json > ../build/wallet_v5_compiled.txt

fift dasm.fif
