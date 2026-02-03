git reset --hard HEAD

git pull

rm -rf node_modules
rm -rf package-lock.json

npm i

rm -rf dist
npm run build

pm2 startOrRestart ecosystem.config.js