'use strict';
/**
 * lib/geoip-lite.js — 轻量 IP 归属段表（R4，sea2 第 4 批增量，零外部依赖）
 * 常量数组 SEGMENTS（~145 条，<10KB）：IP 前缀两段 → 省 + 市；lookup 未命中返回 null。
 * 用途：fleet.listClients 地域列增强——publicIp 命中返回「广东深圳」式省+市。
 * 注意：轻量近似表（非完整 GeoIP 库），仅用于展示聚合。
 */
const SEGMENTS = [
  // 北京
  { prefix: '1.202.', province: '北京', city: '北京' }, { prefix: '106.120.', province: '北京', city: '北京' },
  { prefix: '114.242.', province: '北京', city: '北京' }, { prefix: '123.116.', province: '北京', city: '北京' },
  // 上海
  { prefix: '101.80.', province: '上海', city: '上海' }, { prefix: '114.80.', province: '上海', city: '上海' },
  { prefix: '121.32.', province: '上海', city: '上海' }, { prefix: '122.224.', province: '上海', city: '上海' },
  // 广东·深圳
  { prefix: '14.144.', province: '广东', city: '深圳' }, { prefix: '116.24.', province: '广东', city: '深圳' },
  { prefix: '119.122.', province: '广东', city: '深圳' }, { prefix: '120.229.', province: '广东', city: '深圳' }, { prefix: '59.36.', province: '广东', city: '深圳' },
  // 广东·广州
  { prefix: '113.65.', province: '广东', city: '广州' }, { prefix: '119.32.', province: '广东', city: '广州' },
  { prefix: '14.145.', province: '广东', city: '广州' }, { prefix: '202.96.', province: '广东', city: '广州' },
  // 广东·东莞
  { prefix: '113.88.', province: '广东', city: '东莞' }, { prefix: '119.123.', province: '广东', city: '东莞' },
  { prefix: '120.230.', province: '广东', city: '东莞' },
  // 广东·佛山
  { prefix: '113.68.', province: '广东', city: '佛山' }, { prefix: '119.124.', province: '广东', city: '佛山' },
  { prefix: '120.231.', province: '广东', city: '佛山' },
  // 浙江·杭州
  { prefix: '115.192.', province: '浙江', city: '杭州' }, { prefix: '115.197.', province: '浙江', city: '杭州' },
  { prefix: '122.233.', province: '浙江', city: '杭州' }, { prefix: '125.118.', province: '浙江', city: '杭州' },
  // 浙江·宁波
  { prefix: '115.194.', province: '浙江', city: '宁波' }, { prefix: '122.225.', province: '浙江', city: '宁波' }, { prefix: '125.120.', province: '浙江', city: '宁波' },
  { prefix: '183.129.', province: '浙江', city: '宁波' },
  // 江苏·南京
  { prefix: '114.221.', province: '江苏', city: '南京' }, { prefix: '117.88.', province: '江苏', city: '南京' }, { prefix: '122.192.', province: '江苏', city: '南京' },
  { prefix: '180.111.', province: '江苏', city: '南京' },
  // 江苏·苏州
  { prefix: '114.216.', province: '江苏', city: '苏州' }, { prefix: '121.227.', province: '江苏', city: '苏州' }, { prefix: '180.109.', province: '江苏', city: '苏州' },
  // 四川·成都
  { prefix: '110.184.', province: '四川', city: '成都' }, { prefix: '118.113.', province: '四川', city: '成都' }, { prefix: '125.64.', province: '四川', city: '成都' },
  { prefix: '182.148.', province: '四川', city: '成都' },
  // 湖北·武汉
  { prefix: '111.172.', province: '湖北', city: '武汉' }, { prefix: '113.57.', province: '湖北', city: '武汉' }, { prefix: '119.96.', province: '湖北', city: '武汉' },
  { prefix: '202.103.', province: '湖北', city: '武汉' },
  // 湖南·长沙
  { prefix: '110.52.', province: '湖南', city: '长沙' }, { prefix: '113.240.', province: '湖南', city: '长沙' }, { prefix: '118.250.', province: '湖南', city: '长沙' },
  { prefix: '175.10.', province: '湖南', city: '长沙' },
  // 福建·福州
  { prefix: '110.80.', province: '福建', city: '福州' }, { prefix: '112.110.', province: '福建', city: '福州' }, { prefix: '121.207.', province: '福建', city: '福州' },
  { prefix: '175.42.', province: '福建', city: '福州' },
  // 福建·厦门
  { prefix: '110.82.', province: '福建', city: '厦门' }, { prefix: '112.112.', province: '福建', city: '厦门' }, { prefix: '121.208.', province: '福建', city: '厦门' },
  // 河南·郑州
  { prefix: '115.52.', province: '河南', city: '郑州' }, { prefix: '125.40.', province: '河南', city: '郑州' },
  { prefix: '182.116.', province: '河南', city: '郑州' },
  // 河北·石家庄
  { prefix: '106.113.', province: '河北', city: '石家庄' }, { prefix: '110.248.', province: '河北', city: '石家庄' }, { prefix: '121.28.', province: '河北', city: '石家庄' },
  { prefix: '221.193.', province: '河北', city: '石家庄' },
  // 山东·济南
  { prefix: '112.224.', province: '山东', city: '济南' }, { prefix: '123.130.', province: '山东', city: '济南' }, { prefix: '124.133.', province: '山东', city: '济南' },
  { prefix: '221.0.', province: '山东', city: '济南' },
  // 山东·青岛
  { prefix: '112.226.', province: '山东', city: '青岛' }, { prefix: '123.132.', province: '山东', city: '青岛' }, { prefix: '124.134.', province: '山东', city: '青岛' },
  // 陕西·西安
  { prefix: '1.80.', province: '陕西', city: '西安' }, { prefix: '113.132.', province: '陕西', city: '西安' }, { prefix: '117.22.', province: '陕西', city: '西安' },
  { prefix: '124.114.', province: '陕西', city: '西安' },
  // 安徽·合肥
  { prefix: '112.122.', province: '安徽', city: '合肥' }, { prefix: '114.100.', province: '安徽', city: '合肥' }, { prefix: '117.64.', province: '安徽', city: '合肥' },
  { prefix: '120.242.', province: '安徽', city: '合肥' },
  // 天津
  { prefix: '111.160.', province: '天津', city: '天津' }, { prefix: '117.13.', province: '天津', city: '天津' }, { prefix: '125.36.', province: '天津', city: '天津' },
  { prefix: '221.196.', province: '天津', city: '天津' },
  // 重庆
  { prefix: '113.204.', province: '重庆', city: '重庆' }, { prefix: '119.84.', province: '重庆', city: '重庆' }, { prefix: '125.84.', province: '重庆', city: '重庆' },
  { prefix: '183.64.', province: '重庆', city: '重庆' },
  // 辽宁·沈阳
  { prefix: '113.225.', province: '辽宁', city: '沈阳' }, { prefix: '123.188.', province: '辽宁', city: '沈阳' }, { prefix: '175.147.', province: '辽宁', city: '沈阳' },
  { prefix: '218.24.', province: '辽宁', city: '沈阳' },
  // 吉林·长春
  { prefix: '111.25.', province: '吉林', city: '长春' }, { prefix: '119.48.', province: '吉林', city: '长春' }, { prefix: '122.139.', province: '吉林', city: '长春' },
  // 黑龙江·哈尔滨
  { prefix: '1.56.', province: '黑龙江', city: '哈尔滨' }, { prefix: '111.32.', province: '黑龙江', city: '哈尔滨' }, { prefix: '113.5.', province: '黑龙江', city: '哈尔滨' },
  // 江西·南昌
  { prefix: '111.72.', province: '江西', city: '南昌' }, { prefix: '115.148.', province: '江西', city: '南昌' }, { prefix: '117.116.', province: '江西', city: '南昌' },
  // 广西·南宁
  { prefix: '116.1.', province: '广西', city: '南宁' }, { prefix: '117.140.', province: '广西', city: '南宁' }, { prefix: '121.31.', province: '广西', city: '南宁' },
  // 贵州·贵阳
  { prefix: '1.48.', province: '贵州', city: '贵阳' }, { prefix: '111.85.', province: '贵州', city: '贵阳' }, { prefix: '117.135.', province: '贵州', city: '贵阳' },
  // 云南·昆明
  { prefix: '112.113.', province: '云南', city: '昆明' }, { prefix: '116.52.', province: '云南', city: '昆明' }, { prefix: '222.221.', province: '云南', city: '昆明' },
  // 山西·太原
  { prefix: '110.178.', province: '山西', city: '太原' }, { prefix: '118.74.', province: '山西', city: '太原' }, { prefix: '183.184.', province: '山西', city: '太原' },
  // 内蒙古·呼和浩特
  { prefix: '1.25.', province: '内蒙古', city: '呼和浩特' }, { prefix: '110.17.', province: '内蒙古', city: '呼和浩特' }, { prefix: '116.114.', province: '内蒙古', city: '呼和浩特' },
  // 甘肃·兰州
  { prefix: '118.181.', province: '甘肃', city: '兰州' }, { prefix: '125.74.', province: '甘肃', city: '兰州' }, { prefix: '61.178.', province: '甘肃', city: '兰州' },
  // 宁夏·银川
  { prefix: '1.50.', province: '宁夏', city: '银川' }, { prefix: '111.112.', province: '宁夏', city: '银川' }, { prefix: '120.197.', province: '宁夏', city: '银川' },
  // 新疆·乌鲁木齐
  { prefix: '110.156.', province: '新疆', city: '乌鲁木齐' }, { prefix: '117.139.', province: '新疆', city: '乌鲁木齐' }, { prefix: '118.158.', province: '新疆', city: '乌鲁木齐' },
  // 海南·海口
  { prefix: '112.66.', province: '海南', city: '海口' }, { prefix: '113.58.', province: '海南', city: '海口' }, { prefix: '124.225.', province: '海南', city: '海口' },
  // 港澳台
  { prefix: '1.34.', province: '台湾', city: '台北' }, { prefix: '114.32.', province: '台湾', city: '台北' },
  { prefix: '14.198.', province: '香港', city: '香港' },
];

/**
 * 按 IP 前缀查询归属地。
 * @param {string} ip 公网 IP（如 '59.36.1.2'）
 * @returns {{province:string, city:string}|null} 未命中返回 null
 */
function lookup(ip) {
  const s = String(ip || '').trim();
  if (!s) return null;
  // 仅匹配合法 IPv4 外形（避免脏数据误命中）
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  for (const seg of SEGMENTS) {
    if (s.startsWith(seg.prefix)) {
      return { province: seg.province, city: seg.city };
    }
  }
  return null;
}

/** 段表条目数（测试/自检用） */
function size() {
  return SEGMENTS.length;
}

module.exports = { SEGMENTS, lookup, size };
