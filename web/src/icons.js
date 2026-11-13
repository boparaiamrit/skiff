import { h } from 'preact';
import { html } from './core.js';
// Lucide icons (ISC licence, lucide.dev). Only the icons named here are
// bundled.
import { Activity, AlarmClock, ArrowUp, AtSign, AudioLines, BatteryLow, BatteryMedium, BedDouble, BedSingle, Bell, BellOff, Bluetooth, BookMarked, BookOpen, BookOpenText, Brain, Briefcase, Bug, Cake, Calculator, CalendarDays, CalendarPlus, CalendarRange, CalendarSearch, Camera, Car, CarTaxiFront, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, CircleHelp, CircleSlash, ClipboardCheck, ClipboardCopy, Clock, CloudSun, Code, Coffee, Compass, CookingPot, Copy, Download, Droplet, Dumbbell, ExternalLink, File, FileCode, FileStack, FileText, FlaskConical, Folder, FolderDown, FolderOpen, FolderTree, Footprints, FormInput, GitBranch, GitCompare, GitFork, GitPullRequest, Globe, GraduationCap, Hand, HardDrive, Headphones, Heart, HeartPulse, History, Hourglass, Image, ImagePlus, Images, Inbox, Keyboard, Languages, LayoutGrid, LayoutList, Lightbulb, List, ListPlus, ListTodo, Luggage, Mail, MapPin, Maximize, Megaphone, Menu, MessageCircle, MessageSquare, MessageSquareText, MessagesSquare, Mic, MonitorPlay, Moon, MoonStar, Music, Navigation, Newspaper, NotebookPen, NotebookText, Package, PackageCheck, Paperclip, Pause, PenLine, PenTool, Pencil, PhoneMissed, Plane, Play, Plus, Podcast, RadioTower, Receipt, RefreshCw, Repeat, Reply, Rocket, RotateCcw, Scale, ScanEye, Search, Send, SendHorizontal, Server, Settings, Settings2, Share2, Shield, ShoppingBag, ShoppingCart, Signal, Siren, SkipForward, Smartphone, Sparkles, Square, SquareTerminal, Sun, SunMoon, Sunrise, Sunset, Tag, Target, ThumbsUp, Timer, TrainFront, Trash2, TrendingUp, TriangleAlert, Truck, Undo2, Users, Volume2, VolumeX, Wallet, WandSparkles, Wifi, Wind, Wrench, X } from 'lucide';

// short names used across the UI → Lucide icons
const BASE = {
  chat: MessageSquare,
  phone: Smartphone,
  left: ChevronLeft,
  spark: Sparkles,
  hand: Hand,
  bubble: MessageCircle,
  minimize: ChevronDown,
  expand: Maximize,
  terminal: SquareTerminal,
  folder: Folder,
  file: File,
  globe: Globe,
  gear: Settings,
  plus: Plus,
  x: X,
  send: SendHorizontal,
  stop: Square,
  clip: Paperclip,
  at: AtSign,
  down: ChevronDown,
  right: ChevronRight,
  up: ArrowUp,
  check: Check,
  alert: TriangleAlert,
  refresh: RefreshCw,
  history: History,
  edit: Pencil,
  trash: Trash2,
  copy: Copy,
  ext: ExternalLink,
  brain: Brain,
  tool: Wrench,
  search: Search,
  list: List,
  play: Play,
  keyboard: Keyboard,
  menu: Menu,
  branch: GitBranch,
  shield: Shield,
  image: Image,
  mic: Mic,
  wave: AudioLines,
  volume: Volume2,
  mute: VolumeX,
  clock: Clock,
};
// any icon by its Lucide name (templates, categories)
const BY_NAME = { Activity, AlarmClock, ArrowUp, AtSign, AudioLines, BatteryLow, BatteryMedium, BedDouble, BedSingle, Bell, BellOff, Bluetooth, BookMarked, BookOpen, BookOpenText, Brain, Briefcase, Bug, Cake, Calculator, CalendarDays, CalendarPlus, CalendarRange, CalendarSearch, Camera, Car, CarTaxiFront, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, CircleHelp, CircleSlash, ClipboardCheck, ClipboardCopy, Clock, CloudSun, Code, Coffee, Compass, CookingPot, Copy, Download, Droplet, Dumbbell, ExternalLink, File, FileCode, FileStack, FileText, FlaskConical, Folder, FolderDown, FolderOpen, FolderTree, Footprints, FormInput, GitBranch, GitCompare, GitFork, GitPullRequest, Globe, GraduationCap, Hand, HardDrive, Headphones, Heart, HeartPulse, History, Hourglass, Image, ImagePlus, Images, Inbox, Keyboard, Languages, LayoutGrid, LayoutList, Lightbulb, List, ListPlus, ListTodo, Luggage, Mail, MapPin, Maximize, Megaphone, Menu, MessageCircle, MessageSquare, MessageSquareText, MessagesSquare, Mic, MonitorPlay, Moon, MoonStar, Music, Navigation, Newspaper, NotebookPen, NotebookText, Package, PackageCheck, Paperclip, Pause, PenLine, PenTool, Pencil, PhoneMissed, Plane, Play, Plus, Podcast, RadioTower, Receipt, RefreshCw, Repeat, Reply, Rocket, RotateCcw, Scale, ScanEye, Search, Send, SendHorizontal, Server, Settings, Settings2, Share2, Shield, ShoppingBag, ShoppingCart, Signal, Siren, SkipForward, Smartphone, Sparkles, Square, SquareTerminal, Sun, SunMoon, Sunrise, Sunset, Tag, Target, ThumbsUp, Timer, TrainFront, Trash2, TrendingUp, TriangleAlert, Truck, Undo2, Users, Volume2, VolumeX, Wallet, WandSparkles, Wifi, Wind, Wrench, X };

export function Icon({ name, size = 18, class: cls = '' }) {
  const node = BASE[name] || BY_NAME[name] || BY_NAME.Sparkles;
  return html`<svg class=${'ico ' + cls} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${node.map(([tag, attrs]) => h(tag, attrs))}
  </svg>`;
}

export const hasIcon = (name) => !!(BASE[name] || BY_NAME[name]);
