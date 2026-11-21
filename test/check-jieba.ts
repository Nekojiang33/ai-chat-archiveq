import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';
import { pinyin } from 'pinyin-pro';

const jieba = Jieba.withDict(dict);
const sample = '我用SQLite做向量检索，数据库设计要支持中文分词和pinyin搜索';
const tokens = jieba.cut(sample);
console.log('jieba tokens:', JSON.stringify(tokens));
const py = tokens.map((t: string) => /[\u4e00-\u9fff]/.test(t) ? pinyin(t, { toneType: 'none', type: 'string', nonZh: 'consecutive' }) : t);
console.log('pinyin seg:', py.join(' '));
