#!/bin/sh
set -eu

runtime_dir=/var/www/html/members/www

if [ ! -e "${runtime_dir}/.htaccess" ]; then
    cp "${runtime_dir}/.htaccess.default.http" "${runtime_dir}/.htaccess"
fi

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
